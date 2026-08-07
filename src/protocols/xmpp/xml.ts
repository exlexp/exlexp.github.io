const MAX_STANZA_BYTES = 256 * 1024;

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function parseXmppElement(xml: string): Element {
  if (new TextEncoder().encode(xml).byteLength > MAX_STANZA_BYTES) {
    throw new Error('XMPP stanza exceeds the 256 KiB safety limit');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsafe XML declaration rejected');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) throw new Error('Malformed XMPP XML rejected');
  return document.documentElement;
}

export function descendants(element: Element, localName: string): Element[] {
  return [...element.getElementsByTagNameNS('*', localName)];
}

export function firstDescendant(element: Element, localName: string): Element | undefined {
  return descendants(element, localName)[0];
}

export function textOf(element: Element, localName: string): string | undefined {
  return firstDescendant(element, localName)?.textContent ?? undefined;
}
