const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');
const path = require('path');

// Safe Service Account Loader
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

if (fs.existsSync(serviceAccountPath)) {
  const serviceAccount = require(serviceAccountPath);
  initializeApp({
    credential: cert(serviceAccount),
  });
  console.log('🔑 Firebase Admin initialized with serviceAccountKey.json');
} else {
  console.warn('⚠️ WARNING: serviceAccountKey.json not found in tmcss-backend folder!');
  console.warn('   Download it from: Firebase Console → Project Settings → Service accounts → Generate new private key');
  try {
    initializeApp();
    console.log('ℹ️ Firebase Admin initialized with default credentials.');
  } catch (e) {
    console.error('❌ Failed to initialize Firebase Admin SDK without credentials.');
  }
}

const db = getFirestore();
const auth = getAuth();
const messaging = getMessaging();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

// ─── Health Check Route ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('TMCSS Notification Backend is Running 🚀');
});

// ─── GR/CR Push Notification Endpoint ──────────────────────────────────────────
app.post('/api/notifications/send-grcr', async (req, res) => {
  try {
    // 1. Verify Authorization Header (Firebase ID Token)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Firebase ID Token' });
    }

    const callerUid = decodedToken.uid;

    // 2. Validate Request Body
    const { messageId } = req.body;
    if (!messageId) {
      return res.status(400).json({ error: 'Bad Request: Missing messageId' });
    }

    // 3. Fetch Message Doc from Firestore
    const msgDoc = await db.collection('grcr_messages').doc(messageId).get();
    if (!msgDoc.exists) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const msgData = msgDoc.data();

    // 4. Verify Student Authorization (Caller must be the message creator)
    if (msgData.studentId !== callerUid) {
      return res.status(403).json({ error: 'Forbidden: You did not create this message' });
    }

    // 5. Check Idempotency (Prevent Duplicate Push)
    if (msgData.notificationSent === true) {
      return res.status(200).json({ success: true, message: 'Notification already sent' });
    }

    // 6. Fetch Teacher User Record & Tokens
    const teacherDoc = await db.collection('users').doc(msgData.teacherId).get();
    if (!teacherDoc.exists) {
      return res.status(404).json({ error: 'Teacher record not found' });
    }

    const teacherData = teacherDoc.data();
    const tokens = Array.isArray(teacherData.fcmTokens)
      ? teacherData.fcmTokens.filter(t => typeof t === 'string' && t.trim().length > 0)
      : [];

    if (tokens.length === 0) {
      return res.status(200).json({ success: true, message: 'Teacher has no active FCM tokens' });
    }

    // 7. Prepare FCM Payload
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
        teacherId: msgData.teacherId,
        className: msgData.className,
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

    // 8. Send Push Notifications via FCM Admin SDK Multicast
    const response = await messaging.sendEachForMulticast(payload);
    console.log(`[FCM] Sent messageId=${messageId} to ${tokens.length} tokens. Success: ${response.successCount}, Failure: ${response.failureCount}`);

    // 9. Clean up invalid / unregistered tokens automatically
    const invalidTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const errCode = resp.error?.code;
        if (
          errCode === 'messaging/registration-token-not-registered' ||
          errCode === 'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    if (invalidTokens.length > 0) {
      await db.collection('users').doc(msgData.teacherId).update({
        fcmTokens: FieldValue.arrayRemove(...invalidTokens),
      });
      console.log(`[FCM] Removed ${invalidTokens.length} invalid tokens for teacherId=${msgData.teacherId}`);
    }

    // 10. Mark Message as Processed in Firestore
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
    console.error('[FCM Server Error]', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ TMCSS Backend running on port ${PORT}`);
});
