const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(function loadLocalEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) {
        v = v.slice(1, -1);
      }
      if (k && process.env[k] == null) process.env[k] = v;
    }
  } catch (e) {
    console.warn('Optional .env load failed:', e.message);
  }
})();

const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || '1438252244655087';
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || '376e2336082a7abc44fb4b448491da46';
const INSTAGRAM_REDIRECT_URI =
  process.env.INSTAGRAM_REDIRECT_URI ||
  'https://temp-backend-idyb.onrender.com/auth/instagram/callback';
const SYSTEM_USER_TOKEN = process.env.SYSTEM_USER_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';
const WEBHOOK_CALLBACK_URL = process.env.WEBHOOK_CALLBACK_URL || '';
const FRONTEND_CALLBACK_ORIGIN = process.env.FRONTEND_CALLBACK_ORIGIN || '*';

const app = express();
app.use(cors());
app.use(bodyParser.json());

const MAX_MESSAGES = 200;
let messages = [];
let webhookEvents = [];
let lastOnboardedUser = null;
let lastInstagramOnboardedUser = null;

const ONBOARD_PERMISSION_HINT = [
  'Add these to your Embedded Signup configuration (App Dashboard → WhatsApp → the config matching config_id) and to Facebook Login: business_management, whatsapp_business_management, whatsapp_business_messaging.',
  'Disconnect and run Connect again; accept all permission dialogs so the new scopes are on the user token.',
  'Docs: https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation'
];

function isMissingPermissionGraphPayload(data) {
  const msg = (data && data.error && String(data.error.message)) || '';
  return /permission/i.test(msg);
}

function respondOnboardError(res, err, step) {
  const data = err.response && err.response.data;
  const status = isMissingPermissionGraphPayload(data) ? 403 : 500;
  console.error('ONBOARD ERROR at', step + ':', data || err.message);
  res.status(status).json({
    error: 'Failed onboarding',
    step,
    details: data,
    hint: isMissingPermissionGraphPayload(data) ? ONBOARD_PERMISSION_HINT : undefined
  });
}

// -------------------------------
// Exchange auth code for user access token
// -------------------------------
app.post('/exchange-token', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (!FACEBOOK_APP_SECRET) {
    return res.status(500).json({
      error: 'Set FACEBOOK_APP_SECRET in a .env file next to index.js (App Dashboard → App secret)'
    });
  }

  try {
    const params = {
      client_id: FACEBOOK_APP_ID,
      client_secret: FACEBOOK_APP_SECRET,
      code
    };
    if (process.env.FACEBOOK_REDIRECT_URI) {
      params.redirect_uri = process.env.FACEBOOK_REDIRECT_URI;
    }

    const { data } = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params
    });

    res.json({
      access_token: data.access_token,
      token_type: data.token_type,
      expires_in: data.expires_in
    });
  } catch (err) {
    console.error('EXCHANGE ERROR:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Token exchange failed',
      details: err.response?.data
    });
  }
});

// -------------------------------
// Instagram OAuth code -> short-lived token
// -------------------------------
app.post('/instagram/exchange-token', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (!INSTAGRAM_APP_SECRET) {
    return res.status(500).json({
      error: 'Set INSTAGRAM_APP_SECRET (or FACEBOOK_APP_SECRET) in backend .env'
    });
  }

  try {
    const form = new URLSearchParams();
    form.append('client_id', INSTAGRAM_APP_ID);
    form.append('client_secret', INSTAGRAM_APP_SECRET);
    form.append('grant_type', 'authorization_code');
    form.append('redirect_uri', INSTAGRAM_REDIRECT_URI);
    form.append('code', code);

    const { data } = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      form.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    res.json({
      access_token: data.access_token,
      user_id: data.user_id,
      permissions: data.permissions || null
    });
  } catch (err) {
    console.error('IG EXCHANGE ERROR:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Instagram token exchange failed',
      details: err.response?.data
    });
  }
});

async function onboardInstagramUser(accessToken, userId) {
  let igId = userId || null;
  const meRes = await axios.get('https://graph.instagram.com/me', {
    params: {
      fields: 'user_id,username',
      access_token: accessToken
    }
  });

  const me = meRes.data || {};
  igId = igId || me.user_id || null;
  const igUsername = me.username || null;

  if (!igId) {
    const e = new Error('Instagram user_id could not be resolved from token');
    e.statusCode = 400;
    throw e;
  }

  let subscribeResult = { ok: false };
  try {
    const subRes = await axios.post(
      `https://graph.facebook.com/v19.0/${igId}/subscribed_apps`,
      null,
      {
        headers: {
          Authorization: `Bearer ${SYSTEM_USER_TOKEN || accessToken}`
        }
      }
    );
    subscribeResult = { ok: true, details: subRes.data };
  } catch (e) {
    console.warn('IG subscribed_apps failed:', e.response?.data || e.message);
    subscribeResult = { ok: false, details: e.response?.data || e.message };
  }

  lastInstagramOnboardedUser = {
    igUserId: igId,
    igUsername,
    accessToken,
    subscribed: subscribeResult.ok
  };

  return {
    igUserId: igId,
    igUsername,
    subscribed: subscribeResult.ok,
    subscribeDetails: subscribeResult.details
  };
}

// -------------------------------
// Instagram onboarding: resolve account + subscribe app
// -------------------------------
app.post('/instagram/onboard-user', async (req, res) => {
  const { access_token, user_id } = req.body;
  if (!access_token) {
    return res.status(400).json({ error: 'access_token is required' });
  }

  try {
    const data = await onboardInstagramUser(access_token, user_id);
    res.json(data);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    console.error('IG ONBOARD ERROR:', err.response?.data || err.message);
    res.status(statusCode).json({
      error: 'Instagram onboarding failed',
      details: err.response?.data || err.message
    });
  }
});

// -------------------------------
// Instagram OAuth redirect callback
// -------------------------------
app.get('/auth/instagram/callback', async (req, res) => {
  const code = req.query.code;
  const oauthError = req.query.error || req.query.error_reason;

  if (oauthError) {
    return res.status(200).send(`<!doctype html>
<html><body style="font-family:system-ui;padding:20px;background:#0b1020;color:#fff;">
  <h3>Instagram login canceled</h3>
  <p>You can close this window and retry.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage(${JSON.stringify({
        type: 'INSTAGRAM_BUSINESS_LOGIN',
        status: 'error',
        error: 'Instagram authorization was canceled'
      })}, ${JSON.stringify(FRONTEND_CALLBACK_ORIGIN)});
    }
  </script>
</body></html>`);
  }

  if (!code) {
    return res.status(400).send('Missing code query parameter');
  }

  try {
    const form = new URLSearchParams();
    form.append('client_id', INSTAGRAM_APP_ID);
    form.append('client_secret', INSTAGRAM_APP_SECRET);
    form.append('grant_type', 'authorization_code');
    form.append('redirect_uri', INSTAGRAM_REDIRECT_URI);
    form.append('code', String(code).replace(/#_$/, ''));

    const tokenResp = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      form.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const shortLived = tokenResp.data || {};
    const onboardData = await onboardInstagramUser(shortLived.access_token, shortLived.user_id);

    const payload = {
      type: 'INSTAGRAM_BUSINESS_LOGIN',
      status: 'success',
      data: onboardData
    };

    return res.status(200).send(`<!doctype html>
<html><body style="font-family:system-ui;padding:20px;background:#0b1020;color:#fff;">
  <h3>Instagram connected</h3>
  <p>You can close this window and continue in Responza.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(FRONTEND_CALLBACK_ORIGIN)});
      window.close();
    }
  </script>
</body></html>`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('IG CALLBACK ERROR:', detail);
    const payload = {
      type: 'INSTAGRAM_BUSINESS_LOGIN',
      status: 'error',
      error: 'Instagram login flow failed',
      details: detail
    };
    return res.status(200).send(`<!doctype html>
<html><body style="font-family:system-ui;padding:20px;background:#0b1020;color:#fff;">
  <h3>Instagram connection failed</h3>
  <p>Please close this window and retry.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(FRONTEND_CALLBACK_ORIGIN)});
    }
  </script>
</body></html>`);
  }
});

// -------------------------------
// Send message — prefers last /onboard-user phone + token
// -------------------------------
app.post('/send-message', async (req, res) => {
  const { to, message } = req.body;
  const phoneId = lastOnboardedUser?.phoneNumberId || PHONE_NUMBER_ID;
  const token = lastOnboardedUser?.accessToken || SYSTEM_USER_TOKEN;

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('ERROR (send message):', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to send message', details: error.response?.data });
  }
});

// -------------------------------
// After /exchange-token: WABA + phone (uses user access token)
// -------------------------------
app.post('/onboard-user', async (req, res) => {
  const { access_token, waba_id, phone_number_id, wabaId, phoneNumberId } = req.body;
  const wabaFromClient = waba_id || wabaId;
  const phoneFromClient = phone_number_id || phoneNumberId;

  if (!access_token) {
    return res.status(400).json({ error: 'access_token is required' });
  }

  const auth = { headers: { Authorization: `Bearer ${access_token}` } };

  try {
    try {
      const perms = await axios.get('https://graph.facebook.com/v19.0/me/permissions', auth);
      const granted = (perms.data?.data || [])
        .filter((p) => p.status === 'granted')
        .map((p) => p.permission);
      console.log('Token granted permissions:', granted.length ? granted.join(', ') : '(none)');
    } catch (e) {
      console.warn('me/permissions (diagnostic) failed:', e.response?.data || e.message);
    }

    if (wabaFromClient) {
      console.log('Using waba_id from client (WA_EMBEDDED_SIGNUP or manual):', wabaFromClient);
    }

    let wabaId = wabaFromClient || null;
    let phoneNumberId = phoneFromClient || null;

    if (!wabaId) {
      // Graph path: Business → owned WABA
      // https://developers.facebook.com/documentation/business-messaging/whatsapp/overview
      let businessesRes;
      try {
        businessesRes = await axios.get('https://graph.facebook.com/v19.0/me/businesses', auth);
      } catch (e) {
        return respondOnboardError(res, e, 'me/businesses');
      }

      const businesses = businessesRes.data?.data || [];
      console.log('me/businesses count:', businesses.length);

      for (const biz of businesses) {
        let wabaRes;
        try {
          wabaRes = await axios.get(
            `https://graph.facebook.com/v19.0/${biz.id}/owned_whatsapp_business_accounts`,
            auth
          );
        } catch (e) {
          return respondOnboardError(
            res,
            e,
            `business/${biz.id}/owned_whatsapp_business_accounts`
          );
        }
        const wabas = wabaRes.data?.data || [];
        if (wabas[0]?.id) {
          wabaId = wabas[0].id;
          break;
        }
      }

      if (!wabaId) {
        for (const biz of businesses) {
          let wabaRes;
          try {
            wabaRes = await axios.get(
              `https://graph.facebook.com/v19.0/${biz.id}/client_whatsapp_business_accounts`,
              auth
            );
          } catch (e) {
            return respondOnboardError(
              res,
              e,
              `business/${biz.id}/client_whatsapp_business_accounts`
            );
          }
          const wabas = wabaRes.data?.data || [];
          if (wabas[0]?.id) {
            wabaId = wabas[0].id;
            break;
          }
        }
      }
    }

    if (!wabaId) {
      // User object edge: assigned WABAs (common after Embedded Signup)
      // https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
      try {
        const assigned = await axios.get(
          'https://graph.facebook.com/v19.0/me/assigned_whatsapp_business_accounts',
          auth
        );
        const first = assigned.data?.data?.[0];
        if (first?.id) {
          wabaId = first.id;
          console.log('Using me/assigned_whatsapp_business_accounts:', wabaId);
        }
      } catch (e) {
        console.warn('me/assigned_whatsapp_business_accounts:', e.response?.data || e.message);
      }
    }

    if (!wabaId) {
      return res.status(400).json({
        error: 'No WhatsApp Business Account found for this user.',
        step: 'resolve_waba',
        hint: [
          'me/businesses can be empty even after a successful flow; use the WA_EMBEDDED_SIGNUP postMessage (waba_id) from the same page, or add waba_id to /onboard-user.',
          'See: https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation (Session logging message event listener).'
        ]
      });
    }

    if (!phoneNumberId) {
      let phoneRes;
      try {
        phoneRes = await axios.get(
          `https://graph.facebook.com/v19.0/${wabaId}/phone_numbers`,
          auth
        );
      } catch (e) {
        return respondOnboardError(res, e, 'phone_numbers');
      }
      const phone0 = phoneRes.data?.data?.[0];
      if (!phone0?.id) {
        return res.status(400).json({
          error: 'No phone numbers on this WABA',
          step: 'phone_numbers',
          hint: [
            'If the flow is FINISH_ONLY_WABA, add a number in Business Manager, or pass phone_number_id from WA_EMBEDDED_SIGNUP when present.'
          ]
        });
      }
      phoneNumberId = phone0.id;
    }

    // Mandatory for receiving events for this WABA on your webhook endpoint.
    // Prefer system user token in production; fallback to onboarded user token.
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`,
        null,
        {
          headers: { Authorization: `Bearer ${SYSTEM_USER_TOKEN || access_token}` }
        }
      );
      console.log(
        'Subscribed app to WABA webhook events:',
        wabaId,
        SYSTEM_USER_TOKEN ? '(system token)' : '(user token fallback)'
      );
    } catch (e) {
      console.warn('WABA subscribed_apps failed:', e.response?.data || e.message);
    }

    console.log(
      'Using app-level webhook configuration from Meta Dashboard.',
      WEBHOOK_CALLBACK_URL ? `Configured callback hint: ${WEBHOOK_CALLBACK_URL}` : ''
    );

    lastOnboardedUser = {
      wabaId,
      phoneNumberId,
      accessToken: access_token
    };

    console.log('NEW USER CONNECTED:');
    console.log('WABA:', wabaId);
    console.log('PHONE:', phoneNumberId);

    res.json({
      wabaId,
      phoneNumberId
    });
  } catch (error) {
    console.error('ONBOARD ERROR:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed onboarding', details: error.response?.data });
  }
});

// -------------------------------
// Webhook verification
// -------------------------------
function handleWebhookVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Friendly response when opened manually in a browser
  if (!mode && !token && !challenge) {
    return res.status(200).json({
      ok: true,
      endpoint: '/webhook',
      info: 'Use query params for Meta webhook verification'
    });
  }

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
}

app.get('/webhook', handleWebhookVerify);
app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'responza-backend',
    webhook_verify_endpoint: '/webhook'
  });
});

// -------------------------------
// Receive messages
// -------------------------------
app.post('/webhook', (req, res) => {
  webhookEvents.push(req.body);
  if (webhookEvents.length > 50) {
    webhookEvents.splice(0, webhookEvents.length - 50);
  }

  const object = req.body?.object;

  // -------------------------------
  // WHATSAPP (existing logic)
  // -------------------------------
  if (object === 'whatsapp_business_account') {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      const changes = entry?.changes || [];

      for (const change of changes) {
        const value = change?.value || {};
        const incoming = value?.messages || [];
        const phoneNumberId = value?.metadata?.phone_number_id;

        for (const msg of incoming) {
          const text = msg.text?.body || 'non-text';
          const tagged = phoneNumberId ? `[WA:${phoneNumberId}] ${text}` : text;

          messages.push(tagged);
          if (messages.length > MAX_MESSAGES) {
            messages.splice(0, messages.length - MAX_MESSAGES);
          }

          console.log('WhatsApp message:', tagged);
        }
      }
    }
  }

  // -------------------------------
  // INSTAGRAM (NEW LOGIC)
  // -------------------------------
  if (object === 'instagram') {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      const messaging = entry?.messaging || [];

      for (const event of messaging) {
        const senderId = event?.sender?.id;
        const recipientId = event?.recipient?.id;

        // Incoming message
        if (event.message) {
          const text = event.message?.text || 'non-text';
          const tagged = `[IG:${senderId}] ${text}`;

          messages.push(tagged);
          if (messages.length > MAX_MESSAGES) {
            messages.splice(0, messages.length - MAX_MESSAGES);
          }

          console.log('Instagram message:', tagged);
        }

        // Optional: postbacks (buttons, etc.)
        if (event.postback) {
          console.log('Instagram postback:', event.postback);
        }
      }
    }
  }

  res.sendStatus(200);
});

app.get('/messages', (req, res) => {
  res.json(messages);
});

app.get('/webhook-events', (req, res) => {
  res.json(webhookEvents);
});

app.get('/debug/state', (req, res) => {
  res.json({
    lastOnboardedUser,
    lastInstagramOnboardedUser,
    defaultPhoneNumberId: PHONE_NUMBER_ID,
    webhookCallbackUrl: WEBHOOK_CALLBACK_URL || null,
    webhookVerifyTokenConfigured: Boolean(WEBHOOK_VERIFY_TOKEN),
    messagesCount: messages.length,
    webhookEventsCount: webhookEvents.length
  });
});

app.get('/instagram/state', (req, res) => {
  res.json({
    connected: Boolean(lastInstagramOnboardedUser),
    instagram: lastInstagramOnboardedUser
  });
});

app.get('/debug/subscribed-apps/:wabaId', async (req, res) => {
  const { wabaId } = req.params;
  const results = {};

  for (const [label, tok] of [
    ['system_user_token', SYSTEM_USER_TOKEN],
    ['onboarded_user_token', lastOnboardedUser?.accessToken]
  ]) {
    if (!tok) { results[label] = 'no token'; continue; }
    try {
      const r = await axios.get(
        `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`,
        { headers: { Authorization: `Bearer ${tok}` } }
      );
      results[label] = r.data;
    } catch (e) {
      results[label] = e.response?.data || e.message;
    }
  }

  res.json(results);
});

app.get('/debug/phone/:phoneNumberId', async (req, res) => {
  const { phoneNumberId } = req.params;
  const token = lastOnboardedUser?.accessToken || SYSTEM_USER_TOKEN;

  try {
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          fields:
            'id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,new_name_status,platform_type,status'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch phone number details',
      details: error.response?.data || error.message
    });
  }
});

// Check what callback URL Meta currently has for the app
app.get('/debug/app-webhook', async (req, res) => {
  try {
    const params = {};
    if (FACEBOOK_APP_SECRET) {
      params.appsecret_proof = crypto
        .createHmac('sha256', FACEBOOK_APP_SECRET)
        .update(SYSTEM_USER_TOKEN)
        .digest('hex');
    }
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${FACEBOOK_APP_ID}/subscriptions`,
      {
        headers: { Authorization: `Bearer ${SYSTEM_USER_TOKEN}` },
        params
      }
    );
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// -------------------------------
app.listen(3000, () => {
  console.log('Server running on port 3000');
});
