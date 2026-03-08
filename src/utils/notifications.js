const { Expo } = require('expo-server-sdk');

const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

/**
 * Send a push notification to one user.
 * Silently swallows errors so a failed push never breaks a route.
 */
async function sendPush(pushToken, title, body, data = {}) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) return;

  try {
    await expo.sendPushNotificationsAsync([{
      to:    pushToken,
      sound: 'default',
      title,
      body,
      data,
    }]);
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

/**
 * Resolve a user's push token from their user id.
 */
async function getPushToken(db, userId) {
  const result = await db.query('SELECT push_token FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.push_token ?? null;
}

module.exports = { sendPush, getPushToken };
