const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');
const path = require('path');

// Flexible Service Account Loader (Supports Render Env Var & Local File)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('🔑 Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT environment variable');
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
  }
} else {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
    console.log('🔑 Firebase Admin initialized with local serviceAccountKey.json');
  }
}

if (serviceAccount) {
  initializeApp({
    credential: cert(serviceAccount),
  });
} else {
  console.warn('⚠️ WARNING: No service account credentials found! Attempting default credentials...');
  try {
    initializeApp();
  } catch (e) {
    console.error('❌ Failed to initialize Firebase Admin SDK.');
  }
}

const db = getFirestore();
const auth = getAuth();
const messaging = getMessaging();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// Request Logger Middleware
app.use((req, res, next) => {
  console.log(`📩 [${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// ─── Health Check Route ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('TMCSS Notification Backend is Running 🚀');
});

// ─── Teacher Token Resolution Helper ──────────────────────────────────────────
async function getTeacherTokens(teacherId, teacherName) {
  const tokenList = []; // Array of { docId, token }
  const seenTokens = new Set();
  const searchId = (teacherId || '').trim();
  const searchName = (teacherName || '').trim().toLowerCase();

  // 1. Direct Document Lookup by ID
  if (searchId) {
    const directDoc = await db.collection('users').doc(searchId).get();
    if (directDoc.exists) {
      const data = directDoc.data();
      if (Array.isArray(data?.fcmTokens)) {
        data.fcmTokens.forEach(t => {
          if (typeof t === 'string' && t.trim() && !seenTokens.has(t.trim())) {
            seenTokens.add(t.trim());
            tokenList.push({ docId: directDoc.id, token: t.trim() });
          }
        });
      }
    }
  }

  // 2. Search Users Collection by teacherId, uid, or name
  const usersSnap = await db.collection('users').get();
  usersSnap.forEach(doc => {
    const d = doc.data();
    const uid = (d.uid || doc.id || '').toString();
    const name = (d.name || '').toString().toLowerCase();
    const storedTeacherId = (d.teacherId || '').toString();

    const nameMatch = searchName.length > 0 &&
      (name.includes(searchName) || searchName.includes(name));
    const idMatch = (uid === searchId || storedTeacherId === searchId);

    if (idMatch || nameMatch) {
      if (Array.isArray(d.fcmTokens)) {
        d.fcmTokens.forEach(t => {
          if (typeof t === 'string' && t.trim() && !seenTokens.has(t.trim())) {
            seenTokens.add(t.trim());
            tokenList.push({ docId: doc.id, token: t.trim() });
          }
        });
      }
    }
  });

  return tokenList;
}

// ─── GR/CR Push Notification Endpoint ──────────────────────────────────────────
app.post('/api/notifications/send-grcr', async (req, res) => {
  try {
    // 1. Verify Authorization Header (Firebase ID Token)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.warn('❌ [Auth Error] Missing or invalid Authorization header format');
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (err) {
      console.warn('❌ [Auth Error] Failed to verify Firebase ID Token:', err.message);
      return res.status(401).json({ error: 'Unauthorized: Invalid Firebase ID Token' });
    }

    const callerUid = decodedToken.uid;

    // 2. Validate Request Body
    const { messageId } = req.body;
    if (!messageId) {
      console.warn('❌ [Request Error] Missing messageId in body');
      return res.status(400).json({ error: 'Bad Request: Missing messageId' });
    }

    console.log(`🔍 [FCM Processing] messageId=${messageId}, callerUid=${callerUid}`);

    // 3. Fetch Message Doc from Firestore
    const msgDoc = await db.collection('grcr_messages').doc(messageId).get();
    if (!msgDoc.exists) {
      console.warn(`❌ [Firestore Error] Message document "${messageId}" not found in grcr_messages`);
      return res.status(404).json({ error: 'Message not found' });
    }

    const msgData = msgDoc.data();
    console.log(`📄 [Message Found] Student: "${msgData.studentName}" (${msgData.studentId}), Teacher: "${msgData.teacherName}" (${msgData.teacherId}), Class: "${msgData.className}"`);

    // 4. Fetch Teacher FCM Tokens
    const tokenItems = await getTeacherTokens(msgData.teacherId, msgData.teacherName);
    console.log(`📱 [Tokens Resolved] Found ${tokenItems.length} FCM token(s) for teacher "${msgData.teacherName}"`);

    if (tokenItems.length === 0) {
      console.warn(`⚠️ [FCM Warning] Teacher "${msgData.teacherName}" has 0 active FCM tokens registered in Firestore users collection.`);
      return res.status(200).json({ success: true, message: 'Teacher has no active FCM tokens registered' });
    }

    // 5. Prepare Payload Template
    const typeLabel = msgData.messageType === 'courseContentReminder'
      ? 'Content Reminder'
      : msgData.messageType === 'courseQuery'
        ? 'Course Query'
        : 'General Message';

    // 6. Sequential Push Delivery: Stop immediately after 1 successful notification!
    let delivered = false;
    let deliveredMessageId = null;
    const invalidTokensMap = [];

    console.log(`🚀 [FCM Sending] Testing ${tokenItems.length} token(s) sequentially (will stop after 1st successful delivery)...`);

    for (let i = 0; i < tokenItems.length; i++) {
      const item = tokenItems[i];

      const singlePayload = {
        token: item.token,
        notification: {
          title: `📚 ${typeLabel} — ${msgData.className}`,
          body: `${msgData.studentName} (GR/CR): ${msgData.message}`,
        },
        data: {
          type: 'grcr_new_message',
          messageId: messageId,
          teacherId: String(msgData.teacherId || ''),
          className: String(msgData.className || ''),
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'tmcss_high_importance_channel',
            icon: 'ic_stat_tmcss',
            sound: 'default',
          },
        },
      };

      try {
        const messageIdResult = await messaging.send(singlePayload);
        console.log(`✨ [Success] Token [${i}] delivered successfully! MessageID: ${messageIdResult}`);
        delivered = true;
        deliveredMessageId = messageIdResult;
        break; // Stop immediately so teacher receives EXACTLY 1 notification!
      } catch (sendErr) {
        console.warn(`❌ Token [${i}] failed: ${sendErr.code} - ${sendErr.message}`);
        if (
          sendErr.code === 'messaging/registration-token-not-registered' ||
          sendErr.code === 'messaging/invalid-registration-token'
        ) {
          invalidTokensMap.push(item);
        }
      }
    }

    // 7. Clean up invalid / expired tokens from Firestore user docs
    if (invalidTokensMap.length > 0) {
      for (const item of invalidTokensMap) {
        try {
          await db.collection('users').doc(item.docId).update({
            fcmTokens: FieldValue.arrayRemove(item.token),
          });
          console.log(`🧹 [FCM Cleanup] Removed invalid token from user doc "${item.docId}"`);
        } catch (e) {
          console.warn(`Could not remove invalid token from user doc "${item.docId}": ${e.message}`);
        }
      }
    }

    // 8. Mark Message as Processed in Firestore
    await db.collection('grcr_messages').doc(messageId).update({
      notificationSent: delivered,
      notificationSentAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: delivered,
      deliveredMessageId: deliveredMessageId,
      invalidTokensCleaned: invalidTokensMap.length,
    });
  } catch (error) {
    console.error('❌ [FCM Server Exception]', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TMCSS Backend running on port ${PORT}`);
});
