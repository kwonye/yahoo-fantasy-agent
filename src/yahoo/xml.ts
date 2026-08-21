import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
  removeNSPrefix: false,
});

/** Parse a Yahoo Fantasy XML response while retaining attributes and text. */
export function parseYahooXml(xml: string): unknown {
  if (typeof xml !== "string" || xml.trim() === "")
    throw new Error("Yahoo returned an empty XML response");
  try {
    return parser.parse(xml);
  } catch (error) {
    throw new Error(
      `Unable to parse Yahoo XML response: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Turn fast-xml-parser's attribute/text representation into predictable JSON.
 * Singleton collections remain objects (Yahoo sometimes returns a collection
 * with one item); repeated XML elements are naturally retained as arrays.
 */
export function normalizeYahooResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeYahooResponse);
  if (value === null || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  let text: unknown;
  for (const [key, child] of Object.entries(input)) {
    if (key === "#text") {
      text =
        typeof child === "string"
          ? child.trim()
          : normalizeYahooResponse(child);
      continue;
    }
    if (key.startsWith("@_")) {
      output[key.slice(2)] = normalizeYahooResponse(child);
      continue;
    }
    output[key] = normalizeYahooResponse(child);
  }
  const keys = Object.keys(output);
  if (keys.length === 0 && text !== undefined) return text;
  if (text !== undefined && keys.length > 0) output._text = text;
  return output;
}

export function parseAndNormalizeYahooXml(xml: string): unknown {
  return normalizeYahooResponse(parseYahooXml(xml));
}

export function escapeXml(value: string | number | boolean): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export type XmlContent =
  string | number | boolean | null | undefined | XmlNode | readonly XmlNode[];

export interface XmlNode {
  readonly name: string;
  readonly value?: XmlContent | undefined;
  readonly attributes?:
    Readonly<Record<string, string | number | boolean>> | undefined;
}

/** Small deterministic XML serializer used for Yahoo's documented write bodies. */
export function xmlNode(
  name: string,
  value?: XmlContent,
  attributes?: Readonly<Record<string, string | number | boolean>>,
): XmlNode {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name))
    throw new Error(`Invalid XML element name: ${name}`);
  return { name, value, attributes };
}

export function renderXmlNode(node: XmlNode): string {
  const attributes = node.attributes
    ? Object.entries(node.attributes)
        .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
        .join("")
    : "";
  const value = node.value;
  if (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return `<${node.name}${attributes}/>`;
  }
  const children = Array.isArray(value)
    ? value
        .map((child) =>
          typeof child === "object" && child !== null && "name" in child
            ? renderXmlNode(child as XmlNode)
            : escapeXml(child as string | number | boolean),
        )
        .join("")
    : typeof value === "object"
      ? renderXmlNode(value as XmlNode)
      : escapeXml(value);
  return `<${node.name}${attributes}>${children}</${node.name}>`;
}

export function renderYahooXml(content: XmlNode | readonly XmlNode[]): string {
  const nodes = Array.isArray(content) ? content : [content];
  return `<?xml version="1.0" encoding="UTF-8"?>\n${nodes.map(renderXmlNode).join("")}`;
}
