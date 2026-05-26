/**
 * Santaglia Compass — waitlist-inbound
 * Edge Function que recibe el webhook de Formspree, inserta el contacto
 * en waitlist_contacts y envía el correo de bienvenida via Resend.
 *
 * Variables de entorno requeridas (configurar en Supabase Dashboard → Edge Functions → Secrets):
 *   RESEND_API_KEY           — clave de API de Resend (resend.com)
 *   WAITLIST_WEBHOOK_SECRET  — secreto compartido con Formspree (cualquier string largo)
 *   SUPABASE_URL             — se inyecta automáticamente
 *   SUPABASE_SERVICE_ROLE_KEY — se inyecta automáticamente
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_KEY    = Deno.env.get('RESEND_API_KEY') ?? '';
const WH_SECRET     = Deno.env.get('WAITLIST_WEBHOOK_SECRET') ?? '';
const FROM_EMAIL    = 'Santaglia Compass <compass@santaglia.app>';
const CORS_HEADERS  = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

Deno.serve(async (req: Request) => {
  // Pre-flight CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  // Verificar secreto del webhook — requerido solo si se envía el header
  // (formularios del navegador no envían header; Formspree/server-to-server sí)
  const secret = req.headers.get('X-Webhook-Secret') ?? '';
  if (WH_SECRET && secret && secret !== WH_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  const email  = (body.email ?? '').trim().toLowerCase();
  const nombre = (body.nombre ?? body.name ?? '').trim();
  const fuente = (body.fuente ?? body.source ?? 'santaglia.app landing').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid email' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Cliente Supabase con service role (omite RLS)
  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  // Insertar contacto (ignorar si ya existe — re-submission)
  const { data: contact, error: insertErr } = await sb
    .from('waitlist_contacts')
    .upsert({ email, nombre, fuente, submitted_at: new Date().toISOString() },
             { onConflict: 'email', ignoreDuplicates: true })
    .select()
    .single();

  if (insertErr && insertErr.code !== '23505') {
    console.error('[waitlist-inbound] insert error:', insertErr);
    return new Response(JSON.stringify({ error: insertErr.message }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }

  // Si ya existía (duplicate), no reenviar bienvenida
  const isNew = !insertErr;

  let emailSent = false;
  if (isNew && RESEND_KEY) {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      [email],
        subject: 'Ya estás en la lista de Santaglia Compass 🧭',
        html:    buildWelcomeEmail(email, nombre),
        tags:    [{ name: 'tipo', value: 'bienvenida' }],
      })
    });
    emailSent = resendRes.ok;

    if (emailSent && contact?.id) {
      await sb.from('waitlist_contacts')
        .update({ welcome_sent_at: new Date().toISOString(), status: 'bienvenida' })
        .eq('id', contact.id);
    }
  }

  return new Response(JSON.stringify({ success: true, new_contact: isNew, email_sent: emailSent }), {
    status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
});

/* ── Plantilla de correo de bienvenida ───────────────────────────── */
function buildWelcomeEmail(email: string, nombre: string): string {
  const saludo = nombre ? `Hola, ${nombre.split(' ')[0]}` : 'Hola';
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f2f8;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:600px;margin:2rem auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1);">

  <!-- Header -->
  <div style="background:#1a1a2e;padding:2rem;text-align:center;">
    <div style="color:#ffffff;font-family:Arial,sans-serif;font-size:1.4rem;font-weight:800;letter-spacing:.08em;">SANTAGLIA COMPASS</div>
    <div style="color:#8892b0;font-family:Arial,sans-serif;font-size:.78rem;margin-top:.4rem;letter-spacing:.12em;">🧭 TU BRÚJULA FINANCIERA</div>
  </div>

  <!-- Cuerpo -->
  <div style="padding:2.5rem 2.5rem 2rem;">
    <h2 style="color:#1a1a2e;font-size:1.5rem;margin:0 0 1.25rem;font-weight:700;">
      Ya estás en la lista ✅
    </h2>
    <p style="color:#444;line-height:1.75;margin:.6rem 0;">${saludo},</p>
    <p style="color:#444;line-height:1.75;margin:.6rem 0;">
      Gracias por tu interés en <strong>Santaglia Compass</strong>. Tu registro fue recibido y ya formas parte de nuestra lista de espera del programa Beta.
    </p>
    <p style="color:#444;line-height:1.75;margin:.6rem 0;">
      En las próximas <strong>dos semanas</strong> te contactaremos para coordinar tu acceso y guiarte en el onboarding personalizado.
    </p>

    <!-- Feature box -->
    <div style="background:#f0f4ff;border-left:4px solid #1a1a2e;padding:1.25rem 1.5rem;margin:1.75rem 0;border-radius:0 8px 8px 0;">
      <div style="font-family:Arial,sans-serif;font-weight:700;color:#1a1a2e;margin-bottom:.6rem;font-size:.88rem;letter-spacing:.04em;">
        ¿QUÉ ES SANTAGLIA COMPASS?
      </div>
      <p style="color:#555;font-size:.85rem;line-height:1.65;margin:0;">
        Una plataforma de gestión financiera y operativa diseñada específicamente para despachos de arquitectura e interiorismo. Facturación CFDI, nómina de asimilables, flujo de efectivo, retenciones fiscales y más —todo en un solo lugar, sin hojas de cálculo.
      </p>
    </div>

    <p style="color:#444;line-height:1.75;margin:.6rem 0;">
      Si mientras tanto tienes preguntas o quieres contarnos más sobre tu despacho, puedes responder directamente a este correo.
    </p>
    <p style="color:#444;line-height:1.75;margin:1.5rem 0 0;">¡Hasta pronto!</p>

    <!-- Firma -->
    <div style="margin-top:1.75rem;padding-top:1.5rem;border-top:1px solid #e8ecf0;">
      <strong style="color:#1a1a2e;font-size:.95rem;">Carlos Sánchez de Tagle</strong><br/>
      <span style="color:#888;font-family:Arial,sans-serif;font-size:.8rem;">
        Santaglia &nbsp;·&nbsp; <a href="mailto:info@santaglia.com" style="color:#1a1a2e;text-decoration:none;">info@santaglia.com</a>
      </span>
    </div>
  </div>

  <!-- Footer -->
  <div style="background:#f7f8fc;padding:.9rem 2rem;text-align:center;border-top:1px solid #e8ecf0;">
    <span style="font-family:Arial,sans-serif;font-size:.7rem;color:#aaa;">
      Recibiste este correo porque te registraste en santaglia.app · ${email}
    </span>
  </div>

</div>
</body>
</html>`;
}
