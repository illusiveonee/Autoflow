// /api/stats.js
export default async function handler(req, res) {
  // CORS headers for cross-origin requests (if needed)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  try {
    // 🔌 In production, replace this with your actual data source.
    // You can use Vercel KV, Supabase, PostgreSQL, MongoDB, etc.
    // For now, we return hardcoded zero values as a placeholder.
    // The shape matches what your admin dashboard expects.

    const stats = {
      mrr: 0,                         // Monthly recurring revenue in dollars
      subscribers: 0,                // Number of active subscribers
      prospects: 0,                  // Total prospects found
      emailsSent: 0,                // Total outreach emails sent
      revenueHistory: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] // 12 months (e.g., Jan–Dec)
    };

    // 💡 If you have a database, fetch and replace stats here.
    // Example using Vercel KV:
    // const kv = await kvGet('stats');
    // if (kv) stats = kv;

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Stats API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
