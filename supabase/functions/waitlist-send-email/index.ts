/**
 * Santaglia Compass — waitlist-send-email
 * Edge Function para enviar correos de seguimiento / onboarding
 * desde el dashboard de Compass. Requiere sesión autenticada de Supabase.
 *
 * Body esperado (POST JSON):
 *   { contact_id: string, email_type: 'followup_1'|'followup_2'|'onboarding'|'custom',
 *     mensaje_extra?: string }
 *
 * Variables de entorno:
 *   RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL   = 'Santaglia Compass <compass@santaglia.app>';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  // Verificar sesión Supabase del usuario
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }

  const sbUser = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: authErr } = await sbUser.auth.getUser();
  if (authErr || !user) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }

  const body = await req.json();
  const { contact_id, email_type, mensaje_extra = '' } = body;

  if (!contact_id || !email_type) {
    return new Response('Missing contact_id or email_type', { status: 400, headers: CORS_HEADERS });
  }

  // Cliente admin para leer/escribir sin RLS
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  const { data: contact, error: fetchErr } = await sb
    .from('waitlist_contacts')
    .select('*')
    .eq('id', contact_id)
    .single();

  if (fetchErr || !contact) {
    return new Response('Contact not found', { status: 404, headers: CORS_HEADERS });
  }

  let subject = '';
  let html    = '';

  switch (email_type) {
    case 'followup_1':
      subject = 'Actualización sobre tu acceso a Santaglia Compass 🧭';
      html    = buildFollowup1(contact.email, contact.nombre, mensaje_extra);
      break;
    case 'followup_2':
      subject = 'Tu onboarding en Santaglia Compass está casi listo ✨';
      html    = buildFollowup2(contact.email, contact.nombre, mensaje_extra);
      break;
    case 'onboarding':
      subject = '¡Bienvenido a Santaglia Compass! Acceso listo 🧭🎉';
      html    = buildOnboarding(contact.email, contact.nombre, mensaje_extra);
      break;
    default:
      return new Response('Unknown email_type', { status: 400, headers: CORS_HEADERS });
  }

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL, to: [contact.email], subject, html,
      tags: [{ name: 'tipo', value: email_type }],
    })
  });

  if (resendRes.ok) {
    const updates: Record<string, string> = { updated_at: new Date().toISOString() };
    if (email_type === 'followup_1') {
      updates.followup_1_sent_at = new Date().toISOString();
      updates.status = 'seguimiento_1';
    } else if (email_type === 'followup_2') {
      updates.followup_2_sent_at = new Date().toISOString();
      updates.status = 'seguimiento_2';
    } else if (email_type === 'onboarding') {
      updates.onboarding_at = new Date().toISOString();
      updates.status = 'onboarded';
    }
    await sb.from('waitlist_contacts').update(updates).eq('id', contact_id);
  }

  const resendData = await resendRes.json().catch(() => ({}));
  return new Response(JSON.stringify({ success: resendRes.ok, resend: resendData }), {
    status: resendRes.ok ? 200 : 502,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
});

/* ── Plantillas de seguimiento ──────────────────────────────────── */
function emailShell(contenido: string, email: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0f2f8;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:600px;margin:2rem auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1);">
  <div style="background:#1a1a2e;padding:1.75rem 2rem;text-align:center;">
    <div style="color:#fff;font-family:Arial,sans-serif;font-size:1.3rem;font-weight:800;letter-spacing:.08em;">SANTAGLIA COMPASS</div>
    <div style="color:#8892b0;font-family:Arial,sans-serif;font-size:.75rem;margin-top:.3rem;letter-spacing:.12em;">🧭 TU BRÚJULA FINANCIERA</div>
  </div>
  <div style="padding:2.5rem 2.5rem 2rem;">${contenido}
    <div style="margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid #e8ecf0;">
      <strong style="color:#1a1a2e;font-size:.95rem;">Carlos Sánchez de Tagle</strong><br/>
      <span style="color:#888;font-family:Arial,sans-serif;font-size:.8rem;">
        Santaglia &nbsp;·&nbsp; <a href="mailto:info@santaglia.com" style="color:#1a1a2e;text-decoration:none;">info@santaglia.com</a>
      </span>
    </div>
  </div>
  <div style="background:#f7f8fc;padding:.9rem 2rem;text-align:center;border-top:1px solid #e8ecf0;">
    <span style="font-family:Arial,sans-serif;font-size:.7rem;color:#aaa;">
      Santaglia Compass Beta · ${email}
    </span>
  </div>
</div></body></html>`;
}

function p(text: string) {
  return `<p style="color:#444;line-height:1.75;margin:.75rem 0;">${text}</p>`;
}

function buildFollowup1(email: string, nombre: string, extra: string): string {
  const s = nombre ? `Hola, ${nombre.split(' ')[0]}` : 'Hola';
  const contenido = `
    <h2 style="color:#1a1a2e;font-size:1.3rem;margin:0 0 1rem;font-weight:700;">Seguimos preparando tu acceso</h2>
    ${p(`${s},`)}
    ${p('Solo queríamos escribirte para confirmarte que tu lugar en el programa Beta de <strong>Santaglia Compass</strong> está reservado.')}
    ${p('Estamos en la etapa final de preparación para tu onboarding. En unos días más te compartiremos tus credenciales de acceso y te guiaremos en los primeros pasos.')}
    ${extra ? `<div style="background:#f0f4ff;border-left:4px solid #1a1a2e;padding:1rem 1.25rem;margin:1.5rem 0;border-radius:0 8px 8px 0;color:#444;font-size:.9rem;line-height:1.65;">${extra}</div>` : ''}
    ${p('¡Gracias por tu paciencia!')}
  `;
  return emailShell(contenido, email);
}

function buildFollowup2(email: string, nombre: string, extra: string): string {
  const s = nombre ? `Hola, ${nombre.split(' ')[0]}` : 'Hola';
  const contenido = `
    <h2 style="color:#1a1a2e;font-size:1.3rem;margin:0 0 1rem;font-weight:700;">Tu onboarding está casi listo ✨</h2>
    ${p(`${s},`)}
    ${p('Tu acceso a <strong>Santaglia Compass</strong> está a punto de estar listo. En los próximos días te enviamos otro correo con tus credenciales y una invitación para agendar una sesión de onboarding.')}
    ${p('Mientras tanto, ¿hay algo específico que quieras explorar primero en la plataforma? Puedes responder directamente a este correo y lo preparamos con anticipación.')}
    ${extra ? `<div style="background:#f0f4ff;border-left:4px solid #1a1a2e;padding:1rem 1.25rem;margin:1.5rem 0;border-radius:0 8px 8px 0;color:#444;font-size:.9rem;line-height:1.65;">${extra}</div>` : ''}
    ${p('¡Hasta muy pronto!')}
  `;
  return emailShell(contenido, email);
}

function buildOnboarding(email: string, nombre: string, extra: string): string {
  const s = nombre ? nombre.split(' ')[0] : '';
  const saludo = s ? `¡Bienvenido/a, ${s}!` : '¡Bienvenido/a!';
  const contenido = `
    <h2 style="color:#1a1a2e;font-size:1.3rem;margin:0 0 1rem;font-weight:700;">${saludo} Tu acceso está listo 🎉</h2>
    ${p('Ya tienes acceso a <strong>Santaglia Compass</strong>. Puedes ingresar en:')}
    <div style="text-align:center;margin:1.5rem 0;">
      <a href="https://compass.santaglia.app" style="background:#1a1a2e;color:#fff;font-family:Arial,sans-serif;font-weight:700;font-size:.9rem;padding:.85rem 2rem;border-radius:8px;text-decoration:none;letter-spacing:.05em;display:inline-block;">
        Abrir Santaglia Compass →
      </a>
    </div>
    ${p(`Tu correo de acceso es: <strong>${email}</strong>`)}
    ${extra ? `<div style="background:#f0f4ff;border-left:4px solid #1a1a2e;padding:1rem 1.25rem;margin:1.5rem 0;border-radius:0 8px 8px 0;color:#444;font-size:.9rem;line-height:1.65;">${extra}</div>` : ''}
    ${p('Si tienes dudas durante el proceso, responde este correo y te ayudamos de inmediato.')}
    ${p('¡Bienvenido/a al equipo!')}
  `;
  return emailShell(contenido, email);
}
