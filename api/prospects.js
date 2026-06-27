import { kv } from '@vercel/kv';
import { updateStats } from './_utils.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function extractJSON(text) {
  // Try to find JSON array in the response
  text = text.trim();
  
  // Remove markdown code fences
  text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  
  // Find the first [ and last ]
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON array found in response');
  }
  
  const jsonStr = text.substring(start, end + 1);
  return JSON.parse(jsonStr);
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const prospects = (await kv.get('prospects')) || [];
      return res.status(200).json({ prospects });
    } catch (e) {
      return res.status(500).json({ error: 'KV read error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await kv.set('prospects', []);
      await updateStats();
      return res.status(200).json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: 'Delete failed' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { industry, city, count = 10, manual, name, email, phone, pain, notes, rating } = req.body || {};

  if (manual) {
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    try {
      const existing = (await kv.get('prospects')) || [];
      const prospect = {
        name,
        email,
        city: city || '',
        phone: phone || '',
        industry: industry || '',
        pain: Math.min(100, Math.max(1, parseInt(pain) || 50)),
        rating: parseFloat(rating) || 0,
        notes: notes || '',
        added: new Date().toISOString(),
      };
      existing.push(prospect);
      await kv.set('prospects', existing);
      await updateStats();
      return res.status(200).json({ prospects: [prospect], count: 1 });
    } catch (e) {
      return res.status(500).json({ error: 'Manual save failed' });
    }
  }

  if (!industry || !city) {
    return res.status(400).json({ error: 'industry and city are required for AI search' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel env' });

  let prospects = [];

  try {
    const prompt = `You are a B2B sales researcher for Autoflow, an AI receptionist and reputation management service for small businesses in the US.

Find ${count} realistic ${industry} businesses in ${city} that would benefit from an AI receptionist.

For each business return ONLY these fields:
- name: real-sounding business name with owner name if applicable (e.g. "Michael G. Berz" or "Smith & Associates Law Firm")
- email: realistic owner/manager email (e.g. owner@businessname.com, info@businessname.com, or firstname@businessname.com)
- city: "${city}"
- industry: "${industry}"
- pain: integer 1-100 (higher = more desperate for AI receptionist / missing calls / bad reviews)
- rating: estimated Google review rating 1.0-5.0
- notes: one sentence explaining exactly why they need AI receptionist

Respond ONLY with a valid JSON array. No markdown, no explanation, no code fences. Example:
[{"name":"Smith Dental","email":"drsmith@smithdental.com","city":"${city}","industry":"${industry}","pain":75,"rating":3.8,"notes":"Missing after-hours calls and has 3 unanswered negative reviews"}]`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API ${response.status}: ${err}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    
    console.log('Claude raw response:', content.substring(0, 500));
    
    const parsed = extractJSON(content);
    if (!Array.isArray(parsed)) throw new Error('Claude did not return an array');

    prospects = parsed.map(p => ({
      name: String(p.name || 'Unknown Business'),
      email: String(p.email || ''),
      phone: String(p.phone || ''),
      city: String(p.city || city),
      industry: String(p.industry || industry),
      pain: Math.min(100, Math.max(1, parseInt(p.pain) || 50)),
      rating: Math.min(5, Math.max(1, parseFloat(p.rating) || 3.5)),
      notes: String(p.notes || ''),
      added: new Date().toISOString(),
    }));

  } catch (e) {
    console.error('Claude search failed:', e.message);
    return res.status(500).json({ error: `Claude search failed: ${e.message}` });
  }

  try {
    const existing = (await kv.get('prospects')) || [];
    const existingEmails = new Set(existing.map(p => p.email.toLowerCase()).filter(e => e));
    const fresh = prospects.filter(p => p.email && !existingEmails.has(p.email.toLowerCase()));
    
    // Also dedupe by name within the same city
    const existingNames = new Set(existing.map(p => (p.name + '|' + p.city).toLowerCase()));
    const freshDeduped = fresh.filter(p => !existingNames.has((p.name + '|' + p.city).toLowerCase()));
    
    await kv.set('prospects', [...existing, ...freshDeduped]);
    await updateStats();
    return res.status(200).json({
      prospects: freshDeduped,
      count: freshDeduped.length,
      skipped: prospects.length - freshDeduped.length,
    });
  } catch (e) {
    return res.status(500).json({ error: 'KV save failed' });
  }
}
