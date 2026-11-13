'use strict';

// Generador de la estructura UBL 2.1 mínima para una boleta o factura.
//
// IMPORTANTE: este XML NO está firmado digitalmente. Sirve para el ambiente
// BETA de SUNAT (que valida estructura, no efectos tributarios) y como base
// para cuando se integre un certificado digital en producción.

const { round2 } = require('../moneda');

function esc(valor) {
  return String(valor === null || valor === undefined ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function dosDecimales(valor) {
  return round2(Number(valor) || 0).toFixed(2);
}

function separarNumero(numero) {
  const texto = String(numero || '');
  const partes = texto.split('-');
  if (partes.length === 2 && partes[0] && partes[1]) {
    return { serie: partes[0], correlativo: partes[1] };
  }
  return { serie: 'B001', correlativo: texto || '00000001' };
}

function codigoTipoComprobante(tipo) {
  return String(tipo).toLowerCase() === 'factura' ? '01' : '03';
}

function fechaCorta(fecha) {
  const texto = String(fecha || new Date().toISOString());
  return texto.slice(0, 10);
}

function construirUbl(comprobante, emisor = {}) {
  const { serie, correlativo } = separarNumero(comprobante.numero);
  const tipoCodigo = codigoTipoComprobante(comprobante.tipo);
  const moneda = comprobante.moneda || 'PEN';
  const subtotal = Number(comprobante.subtotal) || 0;
  const igv = Number(comprobante.igv) || 0;
  const total = Number(comprobante.total) || 0;
  const tasa = subtotal > 0 ? igv / subtotal : 0.18;

  const rucEmisor = emisor.ruc || '00000000000';
  const razonSocial = emisor.razonSocial || 'EMPRESA SIN NOMBRE';

  const documentoCliente = comprobante.ruc ? String(comprobante.ruc) : '00000000';
  const tipoDocumentoCliente = comprobante.ruc ? '6' : '1';
  const nombreCliente = comprobante.cliente || 'CLIENTE VARIOS';

  const items = Array.isArray(comprobante.items) ? comprobante.items : [];

  const lineas = items.map((item, indice) => {
    const cantidad = Number(item.cantidad) || 1;
    const precio = Number(item.precio_unitario) || 0;
    const lineaSubtotal = Number(item.subtotal);
    const base = Number.isFinite(lineaSubtotal) ? lineaSubtotal : cantidad * precio;
    const linea = {
      id: indice + 1,
      cantidad,
      base,
      igv: base * tasa,
      precioConIgv: precio * (1 + tasa),
      descripcion: item.platillo || item.descripcion || `Ítem ${indice + 1}`,
    };

    return [
      '  <cac:InvoiceLine>',
      `    <cbc:ID>${linea.id}</cbc:ID>`,
      `    <cbc:InvoicedQuantity unitCode="NIU">${linea.cantidad}</cbc:InvoicedQuantity>`,
      `    <cbc:LineExtensionAmount currencyID="${moneda}">${dosDecimales(linea.base)}</cbc:LineExtensionAmount>`,
      '    <cac:PricingReference>',
      '      <cac:AlternativeConditionPrice>',
      `        <cbc:PriceAmount currencyID="${moneda}">${dosDecimales(linea.precioConIgv)}</cbc:PriceAmount>`,
      '        <cbc:PriceTypeCode>01</cbc:PriceTypeCode>',
      '      </cac:AlternativeConditionPrice>',
      '    </cac:PricingReference>',
      '    <cac:TaxTotal>',
      `      <cbc:TaxAmount currencyID="${moneda}">${dosDecimales(linea.igv)}</cbc:TaxAmount>`,
      '      <cac:TaxSubtotal>',
      `        <cbc:TaxableAmount currencyID="${moneda}">${dosDecimales(linea.base)}</cbc:TaxableAmount>`,
      `        <cbc:TaxAmount currencyID="${moneda}">${dosDecimales(linea.igv)}</cbc:TaxAmount>`,
      '        <cac:TaxCategory>',
      '          <cbc:ID>S</cbc:ID>',
      '          <cbc:Percent>18.00</cbc:Percent>',
      '          <cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>',
      '          <cac:TaxScheme>',
      '            <cbc:ID>1000</cbc:ID>',
      '            <cbc:Name>IGV</cbc:Name>',
      '            <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>',
      '          </cac:TaxScheme>',
      '        </cac:TaxCategory>',
      '      </cac:TaxSubtotal>',
      '    </cac:TaxTotal>',
      '    <cac:Item>',
      `      <cbc:Description>${esc(linea.descripcion)}</cbc:Description>`,
      '    </cac:Item>',
      '    <cac:Price>',
      `      <cbc:PriceAmount currencyID="${moneda}">${dosDecimales(precio)}</cbc:PriceAmount>`,
      '    </cac:Price>',
      '  </cac:InvoiceLine>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    '  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    '  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    '  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>',
    '  <cbc:CustomizationID>2.0</cbc:CustomizationID>',
    `  <cbc:ID>${esc(comprobante.numero)}</cbc:ID>`,
    `  <cbc:IssueDate>${fechaCorta(comprobante.fecha)}</cbc:IssueDate>`,
    `  <cbc:InvoiceTypeCode>${tipoCodigo}</cbc:InvoiceTypeCode>`,
    `  <cbc:DocumentCurrencyCode>${esc(moneda)}</cbc:DocumentCurrencyCode>`,
    '  <cac:AccountingSupplierParty>',
    '    <cac:Party>',
    '      <cac:PartyIdentification>',
    `        <cbc:ID schemeID="6">${esc(rucEmisor)}</cbc:ID>`,
    '      </cac:PartyIdentification>',
    '      <cac:PartyLegalEntity>',
    `        <cbc:RegistrationName>${esc(razonSocial)}</cbc:RegistrationName>`,
    '      </cac:PartyLegalEntity>',
    '    </cac:Party>',
    '  </cac:AccountingSupplierParty>',
    '  <cac:AccountingCustomerParty>',
    '    <cac:Party>',
    '      <cac:PartyIdentification>',
    `        <cbc:ID schemeID="${tipoDocumentoCliente}">${esc(documentoCliente)}</cbc:ID>`,
    '      </cac:PartyIdentification>',
    '      <cac:PartyLegalEntity>',
    `        <cbc:RegistrationName>${esc(nombreCliente)}</cbc:RegistrationName>`,
    '      </cac:PartyLegalEntity>',
    '    </cac:Party>',
    '  </cac:AccountingCustomerParty>',
    '  <cac:TaxTotal>',
    `    <cbc:TaxAmount currencyID="${moneda}">${dosDecimales(igv)}</cbc:TaxAmount>`,
    '    <cac:TaxSubtotal>',
    `      <cbc:TaxableAmount currencyID="${moneda}">${dosDecimales(subtotal)}</cbc:TaxableAmount>`,
    `      <cbc:TaxAmount currencyID="${moneda}">${dosDecimales(igv)}</cbc:TaxAmount>`,
    '      <cac:TaxCategory>',
    '        <cbc:ID>S</cbc:ID>',
    '        <cbc:Percent>18.00</cbc:Percent>',
    '        <cac:TaxScheme>',
    '          <cbc:ID>1000</cbc:ID>',
    '          <cbc:Name>IGV</cbc:Name>',
    '          <cbc:TaxTypeCode>VAT</cbc:TaxTypeCode>',
    '        </cac:TaxScheme>',
    '      </cac:TaxCategory>',
    '    </cac:TaxSubtotal>',
    '  </cac:TaxTotal>',
    '  <cac:LegalMonetaryTotal>',
    `    <cbc:LineExtensionAmount currencyID="${moneda}">${dosDecimales(subtotal)}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${moneda}">${dosDecimales(total)}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${moneda}">${dosDecimales(total)}</cbc:PayableAmount>`,
    '  </cac:LegalMonetaryTotal>',
    ...lineas,
    '</Invoice>',
  ].join('\n');
}

function nombreArchivo(ruc, tipo, numero) {
  const { serie, correlativo } = separarNumero(numero);
  const codigo = codigoTipoComprobante(tipo);
  const base = `${ruc}-${codigo}-${serie}-${correlativo}`;
  return { base, xml: `${base}.xml`, zip: `${base}.zip` };
}

module.exports = { construirUbl, nombreArchivo, separarNumero, codigoTipoComprobante };
