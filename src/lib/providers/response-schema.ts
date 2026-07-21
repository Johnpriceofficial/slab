export class ProviderSchemaError extends Error {
  readonly provider: string;
  readonly path: string;

  constructor(provider: string, path: string, message: string) {
    super(`${provider} response invalid at ${path}: ${message}`);
    this.name = "ProviderSchemaError";
    this.provider = provider;
    this.path = path;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireRecord(provider: string, value: unknown, path = "$"): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderSchemaError(provider, path, "expected an object");
  return value;
}

export function optionalArray(provider: string, value: unknown, path: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ProviderSchemaError(provider, path, "expected an array");
  return value;
}

export function optionalRecord(provider: string, value: unknown, path: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return requireRecord(provider, value, path);
}

export function optionalString(provider: string, value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProviderSchemaError(provider, path, "expected a string");
  return value;
}

export function optionalNumberLike(provider: string, value: unknown, path: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new ProviderSchemaError(provider, path, "expected a finite number or numeric string");
  return number;
}

export function validatePriceChartingEnvelope(endpoint: string, payload: unknown): Record<string, unknown> {
  const body = requireRecord("PriceCharting", payload);
  if (endpoint === "products" && body.products !== undefined) {
    const products = optionalArray("PriceCharting", body.products, "$.products");
    products.forEach((item, index) => requireRecord("PriceCharting", item, `$.products[${index}]`));
  }
  if (endpoint === "offers" && body.offers !== undefined) {
    const offers = optionalArray("PriceCharting", body.offers, "$.offers");
    offers.forEach((item, index) => requireRecord("PriceCharting", item, `$.offers[${index}]`));
  }
  return body;
}
