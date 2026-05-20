#!/usr/bin/env python3
"""
Parsea todos los CFDIs de los 4 Consecutivos y genera el JSON
para cargarlo en localStorage de facturacion.html
"""

import os, json, re
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime

BASE = Path("/Users/carlossanchezdetagleruiz/Library/CloudStorage/OneDrive-Personal/SANTAGLIA/Finanzas/03-Cobranza/01-Consecutivo Facturas")

NS = {
    'cfdi':  'http://www.sat.gob.mx/cfd/3',
    'cfdi4': 'http://www.sat.gob.mx/cfd/4',
    'tfd':   'http://www.sat.gob.mx/TimbreFiscalDigital',
}

def fmt_num(n):
    try:
        return f"{float(n):,.2f}"
    except:
        return ""

def get_attr(el, *names):
    for n in names:
        v = el.get(n)
        if v: return v
    return ""

def parse_cfdi(path):
    try:
        tree = ET.parse(path)
        root = tree.getroot()
    except Exception as e:
        return None

    tag = root.tag
    # Detect namespace version
    if 'cfd/4' in tag:
        ns_cfdi = 'http://www.sat.gob.mx/cfd/4'
    else:
        ns_cfdi = 'http://www.sat.gob.mx/cfd/3'

    def find(el, path_):
        return el.find(path_, {
            'cfdi': ns_cfdi,
            'tfd': 'http://www.sat.gob.mx/TimbreFiscalDigital'
        })
    def findall(el, path_):
        return el.findall(path_, {
            'cfdi': ns_cfdi,
            'tfd': 'http://www.sat.gob.mx/TimbreFiscalDigital'
        })

    # ── Datos del comprobante ──
    folio      = root.get('Folio', '')
    serie      = root.get('Serie', '')
    fecha_raw  = root.get('Fecha', '')
    subtotal   = root.get('SubTotal', '0')
    total      = root.get('Total', '0')
    moneda     = root.get('Moneda', 'MXN')
    tc         = root.get('TipoCambio', '1')
    forma_pago = root.get('FormaPago', '')
    metodo_pago= root.get('MetodoPago', '')

    no = (serie + folio).strip() if folio else Path(path).stem

    fecha = fecha_raw[:10] if fecha_raw else ''

    # ── Receptor ──
    receptor = find(root, 'cfdi:Receptor')
    cliente  = receptor.get('Nombre', '') if receptor is not None else ''
    rfc_rec  = receptor.get('Rfc', '')   if receptor is not None else ''

    # ── Conceptos (primer concepto como servicio principal) ──
    conceptos   = findall(root, 'cfdi:Conceptos/cfdi:Concepto')
    servicio    = conceptos[0].get('Descripcion', '') if conceptos else ''
    cantidad    = conceptos[0].get('Cantidad', '')    if conceptos else ''
    precio_unit = conceptos[0].get('ValorUnitario', '') if conceptos else ''

    # ── IVA ──
    iva_pct  = '0'
    iva_importe = 0.0
    imp_node = find(root, 'cfdi:Impuestos')
    if imp_node is not None:
        traslados = findall(imp_node, 'cfdi:Traslados/cfdi:Traslado')
        for t in traslados:
            tasa = t.get('TasaOCuota', '0')
            imp  = t.get('Importe', '0')
            try:
                tasa_f = float(tasa)
                if tasa_f > 0:
                    iva_pct = str(int(round(tasa_f * 100)))
                    iva_importe += float(imp)
            except:
                pass

    # ── UUID (timbre) ──
    complemento = find(root, 'cfdi:Complemento')
    uuid = ''
    if complemento is not None:
        tfd_el = complemento.find('{http://www.sat.gob.mx/TimbreFiscalDigital}TimbreFiscalDigital')
        if tfd_el is not None:
            uuid = tfd_el.get('UUID', '')

    # ── Importes según moneda ──
    try:
        subtotal_f = float(subtotal)
        total_f    = float(total)
        tc_f       = float(tc) if tc and tc != 'N/A' else 1.0
    except:
        subtotal_f, total_f, tc_f = 0, 0, 1.0

    if moneda == 'USD':
        imp_usd = fmt_num(subtotal_f)
        imp_mxn = fmt_num(subtotal_f * tc_f)
        total_mxn = fmt_num(total_f * tc_f + iva_importe * tc_f) if iva_importe else fmt_num(total_f * tc_f)
    else:
        imp_mxn = fmt_num(subtotal_f)
        imp_usd = fmt_num(subtotal_f / tc_f) if tc_f > 1 else ''
        total_mxn = fmt_num(total_f)

    # Carpeta de origen como categoría extra
    carpeta = Path(path).parent.name  # Consecutivo1, etc.

    return {
        'id':          uuid or str(abs(hash(str(path))))[:12],
        'no':          no,
        'serie':       serie,
        'fecha':       fecha,
        'cliente':     cliente,
        'rfcCliente':  rfc_rec,
        'servicio':    servicio[:120] if servicio else '',
        'cant':        cantidad,
        'precio':      precio_unit,
        'moneda':      moneda,
        'tcambio':     tc if tc and tc != 'N/A' else '1',
        'impUsd':      imp_usd,
        'impMxn':      imp_mxn,
        'ivaPct':      iva_pct,
        'total':       total_mxn,
        'vendedor':    '',
        'dias':        '',
        'estado':      'Cobrada',
        'pagada':      'Sí',
        'fcobro':      '',
        'plazo':       metodo_pago,
        'cuenta':      '',
        'comprobante': uuid,
        'carpeta':     carpeta,
        'creado':      datetime.now().isoformat(),
    }

# ── Recorrer todos los Consecutivos ──
facturas = []
errores  = []

for n in range(1, 5):
    folder = BASE / f"Consecutivo{n}"
    xmls   = sorted(folder.glob("*.xml"))
    print(f"Consecutivo{n}: {len(xmls)} XMLs")
    for xml_path in xmls:
        result = parse_cfdi(xml_path)
        if result:
            facturas.append(result)
        else:
            errores.append(str(xml_path))

# Ordenar por número de factura (folio numérico)
def sort_key(f):
    no = re.sub(r'[^0-9]', '', f.get('no', ''))
    return int(no) if no else 0

facturas.sort(key=sort_key)

# Eliminar duplicados por UUID (consecutivo3 repite algunos de consecutivo2)
seen_uuids = set()
unicas = []
for f in facturas:
    uid = f.get('comprobante') or f.get('id')
    if uid and uid in seen_uuids:
        continue
    seen_uuids.add(uid)
    unicas.append(f)

print(f"\nTotal facturas únicas: {len(unicas)}")
print(f"Errores de parseo: {len(errores)}")

# ── Generar el JS de carga ──
out_js = Path("/Users/carlossanchezdetagleruiz/Library/CloudStorage/OneDrive-Personal/SANTAGLIA/Sistema Santaglia/sitio-web/js/cargar_facturas.js")

js = f"""/* Generado automáticamente — {datetime.now().strftime('%Y-%m-%d %H:%M')} */
/* {len(unicas)} facturas de Consecutivo1-4 */
(function() {{
  const KEY = 'stgl_facturas';
  const existentes = JSON.parse(localStorage.getItem(KEY) || '[]');
  if (existentes.length > 0) {{
    if (!confirm('Ya hay ' + existentes.length + ' facturas en el sistema. ¿Reemplazar con los ' + {len(unicas)} + ' datos importados?')) return;
  }}
  const data = {json.dumps(unicas, ensure_ascii=False, indent=2)};
  localStorage.setItem(KEY, JSON.stringify(data));
  alert('✓ ' + data.length + ' facturas importadas correctamente.');
  location.reload();
}})();
"""

out_js.write_text(js, encoding='utf-8')
print(f"\nArchivo generado: {out_js}")

# ── Resumen por carpeta ──
from collections import Counter
por_carpeta = Counter(f['carpeta'] for f in unicas)
print("\nResumen por carpeta:")
for k, v in sorted(por_carpeta.items()):
    print(f"  {k}: {v} facturas")

# ── Muestra de datos ──
print("\nPrimeras 3 facturas:")
for f in unicas[:3]:
    print(f"  No.{f['no']} | {f['fecha']} | {f['cliente'][:40]} | {f['moneda']} {f['total']}")
