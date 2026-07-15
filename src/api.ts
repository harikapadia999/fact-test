export const fetchJson = async (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem("token");
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const finalOptions = {
    ...options,
    headers,
    credentials: "same-origin" as RequestCredentials,
  };

  const res = await fetch(url, finalOptions);
  const contentType = res.headers.get("content-type");
  if (
    res.status === 401 &&
    !url.includes("/api/login") &&
    !url.includes("/api/me") &&
    typeof window !== "undefined"
  ) {
    window.dispatchEvent(new Event("auth_expired"));
  }
  if (contentType && contentType.includes("application/json")) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP error ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return null;
};
