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

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 测试数据库连接
pool.connect((err, client, release) => {
  if (err) {
    return console.error('数据库连接失败:', err.stack);
  }
  console.log('✅ Connected to PostgreSQL database.');
});

// 🚩 Stripe webhook 必须在 express.json 之前注册
app.post("/webhook", express.raw({ type: '*/*' }), async (req, res) => {

  let event;
  const signature = req.headers["stripe-signature"];

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log('✅ Webhook received:', event.type);
  } catch (err) {
    console.error(`⚠️ Webhook Error: ${err.message}`);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { line_id, group_id, plan } = session.metadata;

    try {
      const client = await pool.connect();
      const insertQuery = `
        INSERT INTO users (line_id, group_id, plan)
        VALUES ($1, $2, $3)
      `;

      await client.query(insertQuery, [line_id, group_id, plan]);
      client.release();
      console.log('✅ 数据成功存入 PostgreSQL 数据库');

      // 更新额度
      await updateQuota(line_id, group_id, plan);

    } catch (dbError) {
      console.error('⚠️ 数据库写入失败:', dbError);
    }
  }

  res.sendStatus(200);
});

// 🚩 其他 API 路由使用 express.json()
app.use(express.json());

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

  console.log(`✅ 用户 ${line_id} 的额度更新为 ${newQuota} 字符，群组限制为 ${groupLimit} 个。`);
}

// Customer Portal入口
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
