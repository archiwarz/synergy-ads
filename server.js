require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    console.log('✓ Supabase conectado');
  } else {
    console.error('ERROR: Faltan variables SUPABASE_URL o SUPABASE_SERVICE_KEY');
  }
} catch(e) {
  console.error('ERROR Supabase init:', e.message);
}

const AI_LIMITS = { basico: 10, estandar: 50, ilimitado: Infinity, invitado: 0 };
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function getToken(req) {
  const t = req.query.token || req.headers['x-meta-token'];
  if (t && t !== 'null' && t !== 'undefined') return t;
  return process.env.META_ACCESS_TOKEN;
}

function getAccountId(req) {
  const id = req.query.account_id || req.headers['x-account-id'] || process.env.META_ACCOUNT_ID || '';
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
      name: item.name, status: item.status,
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return await res.json();
  } finally { clearTimeout(timeout); }
}

function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
  return m ? m[1] : text;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Base de datos no disponible.' });
  const fbId = req.headers['x-facebook-id'];
  const sessionToken = req.headers['x-session-token'];
  if (!fbId && !sessionToken) return res.status(401).json({ error: 'No autorizado' });
  try {
    let query = supabase.from('users').select('*');
    if (fbId) query = query.eq('facebook_id', fbId);
    else query = query.eq('session_token', sessionToken);
    const { data: user } = await query.single();
    if (!user || !user.active) return res.status(403).json({ error: 'Acceso denegado' });
    req.user = user;
    next();
  } catch(e) {
    return res.status(500).json({ error: 'Error de base de datos: ' + e.message });
  }
}

function requireAdmin(req, res, next) {
  if (!['superadmin', 'admin'].includes(req.user?.role)) return res.status(403).json({ error: 'Se requieren permisos de administrador' });
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Se requieren permisos de super administrador' });
  next();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { facebook_id, name, picture, invite_token } = req.body;
    if (!facebook_id) return res.status(400).json({ error: 'facebook_id requerido' });

    const { data: existing } = await supabase.from('users').select('*').eq('facebook_id', facebook_id).single();
    if (existing) {
      const { data: updated } = await supabase.from('users').update({ name, picture }).eq('facebook_id', facebook_id).select().single();
      return res.json({ user: updated });
    }

    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });

    let role = count === 0 ? 'superadmin' : 'invitado';
    let ai_tier = count === 0 ? 'ilimitado' : 'basico';
    let allowed_accounts = [];
    let invited_by = null;

    if (invite_token && count > 0) {
      const { data: invite } = await supabase.from('invites').select('*').eq('token', invite_token).eq('used', false).gt('expires_at', new Date().toISOString()).single();
      if (invite) {
        role = invite.role;
        ai_tier = invite.ai_tier;
        allowed_accounts = invite.allowed_accounts;
        invited_by = invite.created_by;
        await supabase.from('invites').update({ used: true }).eq('id', invite.id);
      }
    }

    const { data: created } = await supabase.from('users').insert({ facebook_id, name, picture, role, ai_tier, allowed_accounts, invited_by }).select().single();
    res.json({ user: created });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// Login sin Meta para usuarios/invitados
app.post('/api/auth/guest', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Base de datos no disponible.' });
    const { name, invite_token } = req.body;
    if (!name || !invite_token) return res.status(400).json({ error: 'Nombre e invitación requeridos' });

    const { data: invite } = await supabase.from('invites').select('*').eq('token', invite_token).eq('used', false).gt('expires_at', new Date().toISOString()).single();
    if (!invite) return res.status(400).json({ error: 'Invitación inválida o expirada' });
    if (['admin', 'superadmin'].includes(invite.role)) return res.status(400).json({ error: 'Este rol requiere login con Meta' });

    const sessionToken = require('crypto').randomBytes(32).toString('hex');
    const { data: user } = await supabase.from('users').insert({
      name, role: invite.role, ai_tier: invite.ai_tier,
      allowed_accounts: invite.allowed_accounts,
      invited_by: invite.created_by,
      session_token: sessionToken, active: true
    }).select().single();

    await supabase.from('invites').update({ used: true, used_by: user.id }).eq('id', invite.id);
    res.json({ user, session_token: sessionToken });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: usuarios ───────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('*').order('created_at', { ascending: false });
    res.json({ users: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role, ai_tier, allowed_accounts, active } = req.body;
    const target = await supabase.from('users').select('role').eq('id', req.params.id).single();
    if (target.data?.role === 'superadmin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'No puedes modificar al superadmin' });
    if (role === 'superadmin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Solo el superadmin puede asignar ese rol' });
    const updates = {};
    if (role !== undefined) updates.role = role;
    if (ai_tier !== undefined) updates.ai_tier = ai_tier;
    if (allowed_accounts !== undefined) updates.allowed_accounts = allowed_accounts;
    if (active !== undefined) updates.active = active;
    const { data } = await supabase.from('users').update(updates).eq('id', req.params.id).select().single();
    res.json({ user: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await supabase.from('users').select('role').eq('id', req.params.id).single();
    if (!target.data) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.data.role === 'superadmin') return res.status(403).json({ error: 'No puedes eliminar al superadmin' });
    if (target.data.role === 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Solo el superadmin puede eliminar admins' });
    await supabase.from('users').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin: invitaciones ───────────────────────────────────────────────────────
app.get('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data } = await supabase.from('invites').select('*, creator:created_by(name)').order('created_at', { ascending: false });
    res.json({ invites: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/invites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role, ai_tier, allowed_accounts, email } = req.body;
    if (role === 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Solo el superadmin puede crear invitaciones de admin' });
    const { data } = await supabase.from('invites').insert({ role, ai_tier, allowed_accounts: allowed_accounts || [], created_by: req.user.id, email: email || null }).select().single();

    // Enviar email si se proporcionó correo
    let emailSent = false;
    let emailError = null;
    if (email && resend) {
      try {
        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        const inviteLink = `${appUrl}?invite=${data.token}`;
        const roleLbl = { admin: 'Administrador', usuario: 'Usuario', invitado: 'Invitado' }[role] || role;
        const tierLbl = { basico: 'Básico (10 consultas/día)', estandar: 'Estándar (50 consultas/día)', ilimitado: 'Ilimitado' }[ai_tier] || ai_tier;
        await resend.emails.send({
          from: 'Synergy Ads <onboarding@resend.dev>',
          to: email,
          subject: 'Invitación a Synergy Ads Intelligence',
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f0f11;color:#f0f0f0;border-radius:12px">
              <div style="background:#1877F2;width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;margin-bottom:20px;color:#fff;text-align:center;line-height:40px">SY</div>
              <h2 style="margin:0 0 8px;font-size:20px;letter-spacing:-0.03em">Te invitaron a Synergy Ads Intelligence</h2>
              <p style="color:#9a9aaa;font-size:14px;line-height:1.6;margin:0 0 24px"><strong style="color:#f0f0f0">${req.user.name}</strong> te invitó a acceder al dashboard de análisis de Meta Ads de Synergy.</p>
              <div style="background:#17171a;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:16px;margin-bottom:24px;font-size:13px">
                <div style="margin-bottom:6px">Rol: <strong>${roleLbl}</strong></div>
                <div>Acceso IA: <strong>${tierLbl}</strong></div>
              </div>
              <a href="${inviteLink}" style="display:block;background:#1877F2;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;text-align:center;margin-bottom:16px">Aceptar invitación</a>
              <p style="color:#5a5a6a;font-size:11px;text-align:center;margin:0">Este link expira en 7 días · Synergy · Voxmarket</p>
            </div>`
        });
        emailSent = true;
      } catch(emailErr) {
        emailError = emailErr.message;
        console.error('Resend error:', emailErr.message);
      }
    }

    res.json({ invite: data, emailSent, emailError });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/invites/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await supabase.from('invites').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invite/:token', async (req, res) => {
  try {
    const { data } = await supabase.from('invites').select('role,ai_tier,allowed_accounts,expires_at,used').eq('token', req.params.token).single();
    if (!data) return res.status(404).json({ error: 'Invitación no encontrada' });
    if (data.used) return res.status(410).json({ error: 'Esta invitación ya fue usada' });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: 'Esta invitación expiró' });
    res.json({ valid: true, role: data.role, ai_tier: data.ai_tier });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Meta API ──────────────────────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const token = getToken(req);
    const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_status,currency&access_token=${token}&limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    let accounts = data.data || [];

    // Filter by allowed_accounts server-side for authenticated non-admin users
    if (supabase) {
      const fbId = req.headers['x-facebook-id'];
      const sessionToken = req.headers['x-session-token'];
      if (fbId || sessionToken) {
        let q = supabase.from('users').select('role,allowed_accounts');
        if (fbId) q = q.eq('facebook_id', fbId);
        else q = q.eq('session_token', sessionToken);
        const { data: user } = await q.single();
        if (user && !['superadmin', 'admin'].includes(user.role)) {
          accounts = (user.allowed_accounts?.length)
            ? accounts.filter(a => user.allowed_accounts.includes(a.id))
            : [];
        }
      }
    }

    res.json({ data: accounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const token = getToken(req);
    const url = `https://graph.facebook.com/v19.0/me?fields=id,name,picture&access_token=${token}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ads', async (req, res) => {
  try {
    const token = getToken(req);
    const accountId = getAccountId(req);
    const url = `https://graph.facebook.com/v19.0/${accountId}/ads?fields=id,name,status,creative{title,body,image_url,thumbnail_url},insights.date_preset(last_90d){spend,impressions,clicks,ctr,actions,cost_per_action_type,frequency}&access_token=${token}&limit=100`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/account-info', async (req, res) => {
  try {
    const token = getToken(req);
    const accountId = getAccountId(req);
    const url = `https://graph.facebook.com/v19.0/${accountId}?fields=id,name,created_time&access_token=${token}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── IA con control de uso ─────────────────────────────────────────────────────
async function checkAndIncrementAI(fbId) {
  const { data: user } = await supabase.from('users').select('ai_tier,ai_usage_count,ai_usage_date,role').eq('facebook_id', fbId).single();
  if (!user) return { allowed: false, reason: 'Usuario no encontrado' };
  if (user.role === 'invitado') return { allowed: false, reason: 'Los invitados no tienen acceso a IA' };

  const limit = AI_LIMITS[user.ai_tier] || 0;
  const today = new Date().toISOString().split('T')[0];
  const count = user.ai_usage_date === today ? user.ai_usage_count : 0;

  if (count >= limit) return { allowed: false, reason: `Límite diario alcanzado (${limit} consultas). Tier: ${user.ai_tier}` };

  await supabase.from('users').update({ ai_usage_count: count + 1, ai_usage_date: today }).eq('facebook_id', fbId);
  return { allowed: true, remaining: limit === Infinity ? '∞' : limit - count - 1 };
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { message, campaignData, history = [] } = req.body;
    const fbId = req.headers['x-facebook-id'];

    if (fbId) {
      const check = await checkAndIncrementAI(fbId);
      if (!check.allowed) return res.status(429).json({ error: check.reason });
    }

    const slim = slimData(campaignData);
    const systemPrompt = `Eres el sistema de análisis de campañas de paid media para Synergy, empresa de inversión privada.
CONTEXTO: objetivo = prospectos EDUCADOS en inversión privada (no leads fríos). KPIs: CPL, CTR, Frecuencia.
${slim.length ? `DATOS (${slim.length} elementos):\n${JSON.stringify(slim)}` : 'Sin datos.'}
RESPONDE ÚNICAMENTE con JSON válido sin markdown:
{"resumen":"2-3 líneas","metricas_clave":[{"nombre":"","valor":"","estado":"bueno|regular|malo","comentario":""}],"campanas_destacadas":[{"nombre":"","tipo":"mejor|peor","razon":"","accion":""}],"recomendaciones":[{"prioridad":"alta|media|baja","titulo":"","descripcion":"","impacto_estimado":""}],"score_general":7}
Benchmarks financieros: CPL bueno <$15, CTR bueno >1.5%, frecuencia problema >3.5.`;

    const data = await callClaude({ model: 'claude-sonnet-4-5', max_tokens: 2000, system: systemPrompt, messages: [...history.slice(-6), { role: 'user', content: message }] });
    if (data.error) return res.status(400).json({ error: data.error.message });

    try { res.json({ reply: JSON.parse(extractJson(data.content[0].text)), isJson: true }); }
    catch { res.json({ reply: data.content[0].text, isJson: false }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/monthly-report', async (req, res) => {
  try {
    const { campaignData, period } = req.body;
    const fbId = req.headers['x-facebook-id'];

    if (fbId) {
      const check = await checkAndIncrementAI(fbId);
      if (!check.allowed) return res.status(429).json({ error: check.reason });
    }

    const slim = slimData(campaignData);
    const data = await callClaude({
      model: 'claude-sonnet-4-5', max_tokens: 2500,
      messages: [{ role: 'user', content: `Analiza ${slim.length} campañas de Meta Ads para Synergy (inversión privada, período: ${period || 'seleccionado'}).
Responde ÚNICAMENTE con JSON válido sin markdown:
{"resumen":"2-3 líneas","metricas_clave":[{"nombre":"Spend total","valor":"$X","estado":"bueno|regular|malo","comentario":""},{"nombre":"CPL promedio","valor":"$X","estado":"bueno|regular|malo","comentario":""},{"nombre":"CTR promedio","valor":"X%","estado":"bueno|regular|malo","comentario":""},{"nombre":"Leads totales","valor":"X","estado":"bueno|regular|malo","comentario":""}],"campanas_destacadas":[{"nombre":"","tipo":"mejor|peor","razon":"con números reales","accion":""}],"recomendaciones":[{"prioridad":"alta|media|baja","titulo":"","descripcion":"","impacto_estimado":""}],"score_general":7}
Top 3 mejores y 3 peores. Mínimo 5 recomendaciones. Benchmarks: CPL<$15 bueno, CTR>1.5% bueno.
Datos: ${JSON.stringify(slim)}` }]
    });
    if (data.error) return res.status(400).json({ error: data.error.message });

    try { res.json({ report: JSON.parse(extractJson(data.content[0].text)), isJson: true }); }
    catch { res.json({ report: data.content[0].text, isJson: false }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`✓ Synergy Ads Intelligence corriendo en http://localhost:${PORT}`));
