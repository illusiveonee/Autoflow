import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET all subscribers
  if (req.method === 'GET') {
    const subscribers = (await kv.get('subscribers')) || [];
    return res.status(200).json({ subscribers });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { email, name, plan } = req.body || {};
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    const subscribers = (await kv.get('subscribers')) || [];
    // Avoid duplicates
    if (!subscribers.find(s => s.email === email)) {
      subscribers.push({
        email,
        name: name || '',
        plan: plan || 'newsletter',
        status: 'active',
        amount: 0,
        created: new Date().toISOString()
      });
      await kv.set('subscribers', subscribers);
      await updateStats();
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription recorded',
      subscriber: { email, name: name || '', plan: plan || 'newsletter', created: new Date().toISOString() }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Reuse the same updateStats function from prospects.js (or duplicate)
// We'll copy it here to keep file self-contained
async function updateStats() {
  const subscribers = (await kv.get('subscribers')) || [];
  const prospects = (await kv.get('prospects')) || [];

  const active = subscribers.filter(s => s.status === 'active');
  const mrr = active.reduce((sum, s) => sum + (s.amount || 0), 0);

  // Revenue history – last 12 months
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

  // Prospect history – last 30 days
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
