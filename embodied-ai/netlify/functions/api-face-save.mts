import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

export default async (request: Request, context: Context) => {
  if (request.method === "GET") {
    // List saved faces
    const store = getStore({ name: "faces", consistency: "eventual" });
    const { blobs } = await store.list();
    const faces = [];
    for (const blob of blobs.slice(0, 50)) {
      const data = await store.get(blob.key, { type: "json" });
      if (data) faces.push({ id: blob.key, ...data });
    }
    return Response.json({ faces });
  }

  if (request.method === "POST") {
    // Save a face
    const body = await request.json();
    const { image_base64, metadata } = body;

    if (!image_base64) {
      return Response.json({ error: "image_base64 required" }, { status: 400 });
    }

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const store = getStore({ name: "faces", consistency: "eventual" });

    await store.setJSON(id, {
      image: image_base64,
      metadata: metadata || {},
      createdAt: new Date().toISOString(),
    });

    return Response.json({ id, saved: true });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const config = {
  path: "/api/face/save",
};
