// src/utils/sseClient.js
export function connectSSE(token, onMessage, onOpen, onError) {
  if (!token) {
    console.warn("[SSE] No auth token found; skipping notifications.");
    return null;
  }

  const base =
    import.meta.env.VITE_API_BASE_URL ||
    "https://movie-ticket-booking-backend-o1m2.onrender.com"; // ✅ your Render backend URL

  const url = `${base}/api/notifications/stream?token=${encodeURIComponent(token)}`;
  console.log("[SSE] Connecting to:", url);

  // Open EventSource
  const es = new EventSource(url, { withCredentials: true });

  es.onopen = (e) => {
    console.log("[SSE] ✅ Connected");
    if (onOpen) onOpen(e);
  };

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      console.log("[SSE] Message:", data);
      if (onMessage) onMessage(data);
    } catch {
      console.log("[SSE] Non-JSON message:", e.data);
    }
  };

  es.onerror = (e) => {
    console.warn("[SSE] ❌ Error / disconnected", e);
    if (onError) onError(e);
  };

  return es;
}
