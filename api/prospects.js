export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { industry, city, pain, count } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel Environment Variables' });
  }

  const verticals = {
    law: 'law firms',
    dental: 'dental practices',
    accounting: 'accounting firms',
    insurance: 'insurance agencies',
    real_estate: 'real estate agencies',
    consulting: 'consulting firms',
    marketing: 'marketing agencies',
    tech: 'tech companies'
  };

  const industryName = verticals[industry] || industry;
  const painContext = pain ? ` that struggle with ${pain}` : '';

  const prompt = `Find ${count || 10} real ${industryName} in ${city}${painContext}.

For each business, provide ONLY a JSON object with these exact fields:
- name: full business name (use real business names)
- type: specific type of business
- city: "${city}"
- rating: estimated Google rating as a number 1.0-5.0 (use realistic values)
- pain: estimated pain score 0-100${pain ? ' based on ' + pain : ''} (higher = more pain)
- email: a realistic business email address. If you know the real email, use it. Otherwise generate a plausible one based on the business name and domain conventions (info@, contact@, hello@, or firstname@ format).

Return ONLY a valid JSON array. No markdown, no explanation, no code blocks. Just the raw JSON array.

Example format:
[
  {"name":"Smith & Associates","type":"Law Firm","city":"${city}","rating":4.5,"pain":35,"email":"info@smithlaw.com"}
]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: 'Claude API error: ' + errText });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    let prospects = [];
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        prospects = JSON.parse(jsonMatch[0]);
      } catch (e) {
        return res.status(500).json({ error: 'Failed to parse Claude response', raw: text });
      }
    }

    prospects = prospects.filter(p => p.name && p.city).map(p => ({
      name: p.name,
      type: p.type || industryName,
      city: p.city || city,
      rating: parseFloat(p.rating) || 4.0,
      pain: parseInt(p.pain) || 30,
      email: p.email || '',
      status: 'prospect'
    }));

    res.status(200).json({ prospects, count: prospects.length });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
