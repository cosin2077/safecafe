export const onRequestGet: PagesFunction = async () =>
  Response.json(
    {
      ok: true,
      service: "safecafe-api",
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  )

export const onRequestPost: PagesFunction = async () =>
  Response.json({ error: "Method not allowed" }, { status: 405, headers: { "cache-control": "no-store" } })
