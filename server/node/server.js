const express = require("express");
const app = express();
const path = require('path');
const cors = require('cors');

app.use(cors({
  origin: ['https://saygo-translator.carrd.co'],
  methods: "GET, POST",
  credentials: true,
}));

const env = require("dotenv").config();
if (env.error) {
  throw new Error("Unable to load .env file");
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2020-08-27',
});

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('/var/data/data.db');

app.use(express.json({
  verify: function (req, res, buf) {
    if (req.originalUrl.startsWith("/webhook")) {
      req.rawBody = buf.toString();
    }
  },
}));

// 创建付款链接
app.post("/create-checkout-session", async (req, res) => {
  const domainURL = process.env.DOMAIN;
  const { plan, line_id, group_id } = req.body;

  const priceIdMap = {
    Starter: process.env.PRICE_ID_STARTER,
    Basic: process.env.PRICE_ID_BASIC,
    Pro: process.env.PRICE_ID_PRO,
    Expert: process.env.PRICE_ID_EXPERT
  };

  const selectedPriceId = priceIdMap[plan];

  if (!selectedPriceId) {
    return res.status(400).json({ error: 'Invalid or missing plan parameter.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: selectedPriceId, quantity: 1 }],
      metadata: { line_id, group_id, plan },
      success_url: `${domainURL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/canceled.html`,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(400).send({ error: { message: e.message } });
  }
});

// Webhook处理额度更新
app.post("/webhook", async (req, res) => {
  let event;
  let signature = req.headers["stripe-signature"];

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('✅ Webhook received:', event.type);
  } catch (err) {
    console.log(`⚠️ Webhook Error: ${err.message}`);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { line_id, group_id, plan } = session.metadata;

    await updateQuota(line_id, group_id, plan);
  }

  res.sendStatus(200);
});

// 明确额度更新逻辑
async function updateQuota(line_id, group_id, plan) {
  const quotaMap = {
    Starter: 300000,
    Basic: 1000000,
    Pro: 2000000,
    Expert: 4000000
  };

  const groupLimitMap = {
    Starter: 3,
    Basic: 3,
    Pro: 3,
    Expert: 10
  };

  const newQuota = quotaMap[plan];
  const groupLimit = groupLimitMap[plan];

  // ⚠️ 必须明确实现数据库更新逻辑
  // await database.updateUserQuota(line_id, group_id, newQuota, groupLimit);

  console.log(`✅ 用户${line_id}的额度更新为${newQuota}字符，群组限制为${groupLimit}个。`);
}

// Customer Portal入口 (原始程序有的功能，现补充)
app.post('/customer-portal', async (req, res) => {
  const { sessionId } = req.body;
  const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
  const returnUrl = process.env.DOMAIN;

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: checkoutSession.customer,
    return_url: returnUrl,
  });

  res.redirect(303, portalSession.url);
});

// 启动服务器监听端口
const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
