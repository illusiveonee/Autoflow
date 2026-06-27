import { kv } from '@vercel/kv';
import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Invalid signature: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerEmail = session.customer_email;
        const amount = session.amount_total / 100;
        const planName = session.metadata?.plan || 'Full Suite';

        const subscribers = (await kv.get('subscribers')) || [];
        // Remove old entry if exists, then add new active one
        const filtered = subscribers.filter(s => s.email !== customerEmail);
        filtered.push({
          email: customerEmail,
          plan: planName,
          amount: amount,
          status: 'active',
          created: new Date().toISOString(),
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        });
        await kv.set('subscribers', filtered);
        await updateStats();
        console.log(`✅ New subscriber: ${customerEmail} ($${amount}/mo)`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerEmail = subscription.customer_email;
        const subscribers = (await kv.get('subscribers')) || [];
        const updated = subscribers.map(s =>
          s.email === customerEmail ? { ...s, status: 'cancelled' } : s
        );
        await kv.set('subscribers', updated);
        await updateStats();
        console.log(`❌ Subscription cancelled: ${customerEmail}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Same updateStats as in prospects.js ───
async function updateStats() {
  const subscribers = (await kv.get('subscribers')) || [];
  const prospects = (await kv.get('prospects')) || [];

  const active = subscribers.filter(s => s.status === 'active');
  const mrr = active.reduce((sum, s) => sum + (s.amount || 0), 0);

  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d);
  }
  const revenueHistory = months.map(monthStart => {
    const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
    return active
      .filter(s => {
        const created = new Date(s.created);
        return created >= monthStart && created < nextMonth;
      })
      .reduce((sum, s) => sum + (s.amount || 0), 0);
  });

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dailyCounts = {};
  prospects.forEach(p => {
    const d = new Date(p.added);
    if (d >= thirtyDaysAgo) {
      const key = d.toISOString().slice(0,10);
      dailyCounts[key] = (dailyCounts[key] || 0) + 1;
    }
  });
  const prospectHistory = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    prospectHistory.push({ date: key, count: dailyCounts[key] || 0 });
  }

  const stats = {
    mrr,
    subscribers: active.length,
    prospects: prospects.length,
    emailsSent: (await kv.get('emailsSent')) || 0,
    revenueHistory,
    prospectHistory,
    updatedAt: new Date().toISOString()
  };

  await kv.set('stats', stats);
}
