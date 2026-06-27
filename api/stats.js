import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    let stats = await kv.get('stats');
    if (!stats) {
      // Default empty stats
      stats = {
        mrr: 0,
        subscribers: 0,
        prospects: 0,
        emailsSent: 0,
        revenueHistory: new Array(12).fill(0),
        prospectHistory: Array.from({ length: 30 }, (_, i) => ({
          date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0,10),
          count: 0
        })),
        updatedAt: new Date().toISOString()
      };
    }
    return res.status(200).json(stats);
  } catch (error) {
    console.error('Stats API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
