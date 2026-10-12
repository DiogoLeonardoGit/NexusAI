let configuration;


export async function getConfiguration() {
  if (!configuration) {
    configuration = window.notetaker
      ? await window.notetaker.config()
      : { apiBase: "http://127.0.0.1:8765/api", apiToken: "development-token" };
  }
  return configuration;
}

export async function api(path, options = {}) {
  const config = await getConfiguration();
  const headers = new Headers(options.headers || {});
  headers.set("X-Local-Token", config.apiToken);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`${config.apiBase}${path}`, { ...options, headers });
  if (!response.ok) {
    const detail = await response.text();
    let message = `API error ${response.status}`;
    try {
      const payload = JSON.parse(detail);
      // Field validation errors belong beside the form, not as raw JSON.
      message = payload.detail || Object.entries(payload).map(([field, errors]) => `${field}: ${Array.isArray(errors) ? errors.join(" ") : String(errors)}`).join("; ") || message;
    } catch {
      message = detail.startsWith("<") ? `API error ${response.status}. Verifica o backend.` : detail || message;
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function apiText(path) {
  const config = await getConfiguration();
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: { "X-Local-Token": config.apiToken },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}
