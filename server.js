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
    const rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    serviceAccount = JSON.parse(rawEnv);
    console.log('🔑 Firebase Admin loaded from FIREBASE_SERVICE_ACCOUNT environment variable');
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON string:', err.message);
  }
} else {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
    console.log('🔑 Firebase Admin loaded from local serviceAccountKey.json');
  }
}

// Fix Render / Env Var newline escaping in RSA Private Key
if (serviceAccount && typeof serviceAccount.private_key === 'string') {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

if (serviceAccount) {
  try {
    initializeApp({
      credential: cert(serviceAccount),
    });
    console.log(`✅ Firebase Admin initialized for project "${serviceAccount.project_id}"`);
  } catch (e) {
    console.error('❌ Failed to initialize Firebase Admin with serviceAccount:', e.message);
  }
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

// Configure CORS for Web / Mobile cross-origin requests
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

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
  const tokens = new Set();
  const searchId = (teacherId || '').trim();
  const searchName = (teacherName || '').trim().toLowerCase();

  // 1. Direct Document Lookup by ID
  if (searchId) {
    const directDoc = await db.collection('users').doc(searchId).get();
    if (directDoc.exists) {
      const data = directDoc.data();
      if (Array.isArray(data?.fcmTokens)) {
        data.fcmTokens.forEach(t => typeof t === 'string' && t.trim() && tokens.add(t.trim()));
      }
    }
  }

  // 2. Fallback: Search Users Collection by teacherId, uid, or name
  if (tokens.size === 0) {
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
          d.fcmTokens.forEach(t => typeof t === 'string' && t.trim() && tokens.add(t.trim()));
        }
      }
    });
  }

  return Array.from(tokens);
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
      console.error('❌ [Auth Error] Failed to verify Firebase ID Token:', err.message);
      return res.status(401).json({ error: 'Unauthorized: Invalid Firebase ID Token', details: err.message });
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

    // 4. Verify Student Authorization (Caller must be the message creator)
    if (msgData.studentId && msgData.studentId !== callerUid && msgData.grcrStudentId !== callerUid) {
      console.warn(`⚠️ [Auth Warning] Caller UID (${callerUid}) does not match stored studentId (${msgData.studentId})`);
    }

    // 5. Fetch Teacher FCM Tokens
    const tokens = await getTeacherTokens(msgData.teacherId, msgData.teacherName);
    console.log(`📱 [Tokens Resolved] Found ${tokens.length} FCM token(s) for teacherId="${msgData.teacherId}" / teacherName="${msgData.teacherName}"`);

    if (tokens.length === 0) {
      console.warn(`⚠️ [FCM Warning] Teacher "${msgData.teacherName}" has 0 active FCM tokens registered in Firestore users collection.`);
      return res.status(200).json({ success: true, message: 'Teacher has no active FCM tokens registered' });
    }

    // 6. Prepare FCM Payload
    const typeLabel = msgData.messageType === 'courseContentReminder'
      ? 'Content Reminder'
      : msgData.messageType === 'courseQuery'
        ? 'Course Query'
        : 'General Message';

    const payload = {
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
      tokens: tokens,
    };

    // 7. Send Push Notifications via FCM Admin SDK Multicast
    console.log(`🚀 [FCM Sending] Dispatching to ${tokens.length} token(s)...`);
    const response = await messaging.sendEachForMulticast(payload);
    console.log(`✅ [FCM Result] Success: ${response.successCount}, Failure: ${response.failureCount}`);

    // 8. Clean up invalid / unregistered tokens automatically
    const invalidTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.error(`❌ Token [${idx}] failed: ${resp.error?.code} - ${resp.error?.message}`);
        const errCode = resp.error?.code;
        if (
          errCode === 'messaging/registration-token-not-registered' ||
          errCode === 'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(tokens[idx]);
        }
      } else {
        console.log(`✨ Token [${idx}] delivered successfully! MessageID: ${resp.messageId}`);
      }
    });

    if (invalidTokens.length > 0 && msgData.teacherId) {
      try {
        await db.collection('users').doc(msgData.teacherId).update({
          fcmTokens: FieldValue.arrayRemove(...invalidTokens),
        });
        console.log(`🧹 [FCM Cleanup] Removed ${invalidTokens.length} invalid token(s) from teacher user document.`);
      } catch (e) {
        console.warn('Could not remove invalid tokens:', e.message);
      }
    }

    // 9. Mark Message as Processed in Firestore
    await db.collection('grcr_messages').doc(messageId).update({
      notificationSent: true,
      notificationSentAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
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
