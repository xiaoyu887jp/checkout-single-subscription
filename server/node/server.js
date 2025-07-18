const express = require("express");
const app = express();
const path = require('path');

// 明确添加 CORS 支持跨域
const cors = require('cors');
const allowedOrigins = ['https://saygo-translator.carrd.co'];

app.use(cors({
  origin: function(origin, callback){
    if(!origin || allowedOrigins.indexOf(origin) !== -1){
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: "GET, POST, OPTIONS",
  credentials: true,
}));

// Copy the .env.example in the root into a .env file in this folder
const envFilePath = path.resolve(__dirname, './.env');
const env = require("dotenv").config({ path: envFilePath });
if (env.error) {
  throw new Error(`Unable to load the .env file from ${envFilePath}. Please copy .env.example to ${envFilePath}`);
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2020-08-27',
  appInfo: { // For sample support and debugging, not required for production:
    name: "stripe-samples/checkout-single-subscription",
    version: "0.0.1",
    url: "https://github.com/stripe-samples/checkout-single-subscription"
  }
});

//app.use(express.static(process.env.STATIC_DIR));
app.use(express.urlencoded({ extended: true }));
app.use(
  express.json({
    // We need the raw body to verify webhook signatures.
    // Let's compute it only when hitting the Stripe webhook endpoint.
    verify: function (req, res, buf) {
      if (req.originalUrl.startsWith("/webhook")) {
        req.rawBody = buf.toString();
      }
    },
  })
);

//app.get("/", (req, res) => {
 // const filePath = path.resolve(process.env.STATIC_DIR + "/index.html");
 // res.sendFile(filePath);
//});

// Fetch the Checkout Session to display the JSON result on the success page
app.post("/create-checkout-session", async (req, res) => {
  const domainURL = process.env.DOMAIN;

  // 从前端获取用户选择的方案 plan，例如 Starter、Basic 等。
  const { plan, line_id, group_id } = req.body;

  const priceIdMap = {
    'Starter': process.env.PRICE_ID_STARTER,
    'Basic': process.env.PRICE_ID_BASIC,
    'Pro': process.env.PRICE_ID_PRO,
    'Expert': process.env.PRICE_ID_EXPERT
  };

  const selectedPriceId = priceIdMap[plan];

  if (!selectedPriceId) {
    return res.status(400).json({ error: 'Invalid or missing plan parameter.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: selectedPriceId, // 这里确保后端正确选择价格
          quantity: 1,
        },
      ],
      metadata: { line_id, group_id, plan }, // 加入 metadata
      success_url: `${domainURL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainURL}/canceled.html`,
    });

    res.json({ url: session.url }); // 返回付款链接给前端
  } catch (e) {
    res.status(400).send({ error: { message: e.message } });
  }
});


app.get("/config", (req, res) => {
  res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    basicPrice: process.env.BASIC_PRICE_ID,
    proPrice: process.env.PRO_PRICE_ID,
  });
});

app.post('/customer-portal', async (req, res) => {
  // For demonstration purposes, we're using the Checkout session to retrieve the customer ID.
  // Typically this is stored alongside the authenticated user in your database.
  const { sessionId } = req.body;
  const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

  // This is the url to which the customer will be redirected when they are done
  // managing their billing with the portal.
  const returnUrl = process.env.DOMAIN;

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: checkoutSession.customer,
    return_url: returnUrl,
  });

  res.redirect(303, portalSession.url);
});

// Webhook handler for asynchronous events.
app.post("/webhook", async (req, res) => {
  let data;
  let eventType;
  // Check if webhook signing is configured.
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    // Retrieve the event by verifying the signature using the raw body and secret.
    let event;
    let signature = req.headers["stripe-signature"];

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(`⚠️  Webhook signature verification failed.`);
      return res.sendStatus(400);
    }
    // Extract the object from the event.
    data = event.data;
    eventType = event.type;
  } else {
    // Webhook signing is recommended, but if the secret is not configured in `config.js`,
    // retrieve the event data directly from the request body.
    data = req.body.data;
    eventType = req.body.type;
  }

  if (eventType === "checkout.session.completed") {
    console.log(`🔔  Payment received!`);
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 4242;
app.listen(port, () => {
  console.log(`Node server listening at http://localhost:${port}/`);
});

