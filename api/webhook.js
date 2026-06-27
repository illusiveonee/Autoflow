import { kv } from '@vercel/kv';
import Stripe from 'stripe';
import { updateStats } from './_utils.js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey     = process.env.STRIPE_SECRET_KEY;

  if (!sig)           return res.status(400).json({ error: 'Missing stripe-signature' });
  if (!webhookSecret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not set' });
  if (!stripeKey)     return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set' });

  let event;
  try {
    const stripe  = new Stripe(stripeKey);
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Invalid signature: ${err.message}` });
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session       = event.data.object;
        const customerEmail = session.customer_email || session.customer_details?.email;
        const amount        = (session.amount_total || 0) / 100;
        const planName      = session.metadata?.plan || 'Full Suite';
        if (!customerEmail) { console.warn('No email on session'); break; }
        const subscribers = (await kv.get('subscribers')) || [];
        const filtered    = subscribers.filter(s => s.email !== customerEmail);
        filtered.push({
          email:                customerEmail,
          name:                 session.customer_details?.name || '',
          plan:                 planName,
          amount,
          status:               'active',
          created:              new Date().toISOString(),
          stripeCustomerId:     session.customer     || null,
          stripeSubscriptionId: session.subscription || null,
        });
        await kv.set('subscribers', filtered);
        await updateStats();
        console.log(`New subscriber: ${customerEmail} — ${planName} ($${amount}/mo)`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        let customerEmail  = subscription.customer_email;
        if (!customerEmail) {
          try {
            const stripe   = new Stripe(stripeKey);
            const customer = await stripe.customers.retrieve(subscription.customer);
            customerEmail  = customer.email;
          } catch (e) {
            console.error('Could not retrieve customer email:', e.message);
          }
        }
        if (customerEmail) {
          const subscribers = (await kv.get('subscribers')) || [];
          await kv.set('subscribers', subscribers.map(s =>
            s.email === customerEmail
              ? { ...s, status: 'cancelled', cancelledAt: new Date().toISOString() }
              : s
          ));
          await updateStats();
          console.log(`Cancelled: ${customerEmail}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice     = event.data.object;
        const subscribers = (await kv.get('subscribers')) || [];
        await kv.set('subscribers', subscribers.map(s =>
          s.stripeSubscriptionId === invoice.subscription
            ? { ...s, status: 'past_due', pastDueAt: new Date().toISOString() }
            : s
        ));
        await updateStats();
        console.log(`Payment failed: ${invoice.subscription}`);
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
