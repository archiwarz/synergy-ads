require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

function getToken(req) {
  return req.query.token || req.body?.token || process.env.META_ACCESS_TOKEN;
}

function getAccountId(req) {
  const id = req.query.account_id || req.body?.account_id || process.env.META_ACCOUNT_ID || '';
  return id.startsWith('act_') ? id : `act_${id}`;
}

function slimData(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 50).map(item => {
    const ins = item.insights?.data?.[0] || {};
    const leads = (ins.actions || [])
      .filter(a => a.action_type === 'lead')
      .reduce((s, a) => s + parseInt(a.value || 0), 0);
    const spend = parseFloat(ins.spend || 0);
    return {
      name: item.name,
      status: item.status,
      spend: spend || null,
      impressions: parseInt(ins.impressions || 0) || null,
      clicks: parseInt(ins.clicks || 0) || null,
      ctr: ins.ctr ? parseFloat(ins.ctr).toFixed(3) : null,
      frequency: ins.frequency ? parseFloat(ins.frequency).toFixed(2) : null,
      leads: leads || null,
      cpl: leads > 0 ? (spend / leads).toFixed(2) : null,
      ...(item.creative?.body && { copy: item.creative.body.substring(0, 150) })
    };
  });
}

async function callClaude(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/)
    || text.match(/```\s*([\s\S]*?)\s*```/)
    || text.match(/(\{[\s\S]*\})/);
  return m ? m[1] : text;
}

// GET cuentas publicitarias accesibles por el token
app.get('/api/accounts', async (req, res) => {
  try {
    const token = getToken(req);
    const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_status,currency&access_token=${token}&limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET info del usuario autenticado
app.get('/api/me', async (req, res) => {
  try {
    const token = getToken(req);
    const url = `https://graph.facebook.com/v19.0/me?fields=id,name,picture&access_token=${token}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET campañas de Meta
app.get('/api/campaigns', async (req, res) => {
  try {
    const token = getToken(req);
    const accountId = getAccountId(req);
    const { date_from = '2024-11-01', date_to = '2025-04-30' } = req.query;
    const timeRange = encodeURIComponent(JSON.stringify({ since: date_from, until: date_to }));
    const url = `https://graph.facebook.com/v19.0/${accountId}/campaigns?fields=id,name,objective,status,daily_budget,lifetime_budget,insights.time_range(${timeRange}){spend,impressions,clicks,ctr,reach,frequency,actions,cost_per_action_type,cpp,cpm}&access_token=${token}&limit=50`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET adsets de una campaña
app.get('/api/campaigns/:id/adsets', async (req, res) => {
  try {
    const token = getToken(req);
    const { date_from = '2024-11-01', date_to = '2025-04-30' } = req.query;
    const timeRange = encodeURIComponent(JSON.stringify({ since: date_from, until: date_to }));
    const url = `https://graph.facebook.com/v19.0/${req.params.id}/adsets?fields=id,name,status,targeting,daily_budget,insights.time_range(${timeRange}){spend,impressions,clicks,ctr,actions,cost_per_action_type}&access_token=${token}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET ads de un adset
app.get('/api/adsets/:id/ads', async (req, res) => {
  try {
    const token = getToken(req);
    const { date_from = '2024-11-01', date_to = '2025-04-30' } = req.query;
    const timeRange = encodeURIComponent(JSON.stringify({ since: date_from, until: date_to }));
    const url = `https://graph.facebook.com/v19.0/${req.params.id}/ads?fields=id,name,status,creative,insights.time_range(${timeRange}){spend,impressions,clicks,ctr,actions}&access_token=${token}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET todos los anuncios de la cuenta con creativos e insights
app.get('/api/ads', async (req, res) => {
  try {
    const token = getToken(req);
    const accountId = getAccountId(req);
    const url = `https://graph.facebook.com/v19.0/${accountId}/ads?fields=id,name,status,creative{title,body,image_url,thumbnail_url},insights.date_preset(last_90d){spend,impressions,clicks,ctr,actions,cost_per_action_type,frequency}&access_token=${token}&limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET info de la cuenta publicitaria
app.get('/api/account-info', async (req, res) => {
  try {
    const token = getToken(req);
    const accountId = getAccountId(req);
    const url = `https://graph.facebook.com/v19.0/${accountId}?fields=id,name,created_time&access_token=${token}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST análisis IA
app.post('/api/analyze', async (req, res) => {
  try {
    const { message, campaignData, history = [] } = req.body;
    const slim = slimData(campaignData);

    const systemPrompt = `Eres el sistema de análisis de campañas de paid media para Synergy, empresa de inversión privada.
CONTEXTO: objetivo = prospectos EDUCADOS en inversión privada (no leads fríos). KPIs: CPL, CTR, Frecuencia.
${slim.length ? `DATOS (${slim.length} elementos):\n${JSON.stringify(slim)}` : 'Sin datos.'}
RESPONDE ÚNICAMENTE con JSON válido sin markdown:
{"resumen":"2-3 líneas","metricas_clave":[{"nombre":"","valor":"","estado":"bueno|regular|malo","comentario":""}],"campanas_destacadas":[{"nombre":"","tipo":"mejor|peor","razon":"","accion":""}],"recomendaciones":[{"prioridad":"alta|media|baja","titulo":"","descripcion":"","impacto_estimado":""}],"score_general":7}
Benchmarks financieros: CPL bueno <$15, CTR bueno >1.5%, frecuencia problema >3.5.`;

    const data = await callClaude({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [...history.slice(-6), { role: 'user', content: message }]
    });
    if (data.error) return res.status(400).json({ error: data.error.message });

    try {
      res.json({ reply: JSON.parse(extractJson(data.content[0].text)), isJson: true });
    } catch {
      res.json({ reply: data.content[0].text, isJson: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST análisis automático mensual
app.post('/api/monthly-report', async (req, res) => {
  try {
    const { campaignData, period } = req.body;
    const slim = slimData(campaignData);

    const data = await callClaude({
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Analiza ${slim.length} campañas de Meta Ads para Synergy (inversión privada, período: ${period || 'seleccionado'}).
Responde ÚNICAMENTE con JSON válido sin markdown:
{"resumen":"2-3 líneas","metricas_clave":[{"nombre":"Spend total","valor":"$X","estado":"bueno|regular|malo","comentario":""},{"nombre":"CPL promedio","valor":"$X","estado":"bueno|regular|malo","comentario":""},{"nombre":"CTR promedio","valor":"X%","estado":"bueno|regular|malo","comentario":""},{"nombre":"Leads totales","valor":"X","estado":"bueno|regular|malo","comentario":""}],"campanas_destacadas":[{"nombre":"","tipo":"mejor|peor","razon":"con números reales","accion":""}],"recomendaciones":[{"prioridad":"alta|media|baja","titulo":"","descripcion":"","impacto_estimado":""}],"score_general":7}
Top 3 mejores y 3 peores. Mínimo 5 recomendaciones. Benchmarks: CPL<$15 bueno, CTR>1.5% bueno.
Datos: ${JSON.stringify(slim)}`
      }]
    });
    if (data.error) return res.status(400).json({ error: data.error.message });

    try {
      res.json({ report: JSON.parse(extractJson(data.content[0].text)), isJson: true });
    } catch {
      res.json({ report: data.content[0].text, isJson: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Synergy Ads Intelligence corriendo en http://localhost:${PORT}`);
});
