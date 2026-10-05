/**
 * Minimal XML reader for the small, flat command responses of Namecheap and NameSilo. It supports
 * elements, attributes, text, entities, CDATA, comments and declarations. It is not a validating
 * parser: DTDs are skipped and never expanded, so entity-expansion attacks do not apply.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Strips a namespace prefix: `ns:Name` becomes `Name`. */
function local(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

export function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt === -1) {
      top.text += decode(input.slice(i));
      break;
    }
    if (lt > i) top.text += decode(input.slice(i, lt));
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('Unterminated comment');
      i = end + 3;
    } else if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('Unterminated CDATA');
      top.text += input.slice(lt + 9, end);
      i = end + 3;
    } else if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('Unterminated declaration');
      i = end + 2;
    } else if (input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt + 2);
      if (end === -1) throw new XmlError('Unterminated doctype');
      i = end + 1;
    } else if (input[lt + 1] === '/') {
      const end = input.indexOf('>', lt);
      if (end === -1) throw new XmlError('Unterminated end tag');
      const name = local(input.slice(lt + 2, end).trim());
      const open = stack.pop();
      if (!open || open === root || open.name !== name) throw new XmlError(`Mismatched end tag ${name}`);
      i = end + 1;
    } else {
      const end = findTagEnd(input, lt + 1);
      const raw = input.slice(lt + 1, end);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const nameMatch = /^\s*([^\s/>]+)/.exec(body);
      if (!nameMatch) throw new XmlError('Malformed start tag');
      const node: XmlNode = { name: local(nameMatch[1]!), attrs: parseAttrs(body.slice(nameMatch[0].length)), children: [], text: '' };
      // A document has exactly one root: a second one (for example an appended error) is malformed.
      if (top === root && root.children.length > 0) throw new XmlError('Multiple root elements');
      top.children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError('Unclosed elements');
  if (root.children.length === 0) throw new XmlError('No root element');
  if (root.text.trim() !== '') throw new XmlError('Text outside the root element');
  return root.children[0]!;
}

function findTagEnd(input: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  throw new XmlError('Unterminated start tag');
}

/** Strict attributes: name="value" or name='value' separated by whitespace, no duplicates. */
function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /\s+([^\s=/>"']+)\s*=\s*("([^"]*)"|'([^']*)')/y;
  let index = 0;
  while (index < text.length) {
    if (/^\s*$/.test(text.slice(index))) break;
    re.lastIndex = index;
    const match = re.exec(text);
    if (!match) throw new XmlError('Malformed attribute');
    const name = local(match[1]!);
    if (name in attrs) throw new XmlError(`Duplicate attribute ${name}`);
    attrs[name] = decode(match[3] ?? match[4] ?? '');
    index = re.lastIndex;
  }
  return attrs;
}

/** Depth-first search for elements with a (case-insensitive) local name. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const target = name.toLowerCase();
  const walk = (n: XmlNode) => {
    for (const child of n.children) {
      if (child.name.toLowerCase() === target) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

export function childText(node: XmlNode, name: string): string | null {
  const child = node.children.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return child ? child.text.trim() : null;
}
