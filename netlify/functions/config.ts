// Serves runtime config as JS so the backend URL never has to be hardcoded
// in the checked-in HTML — index.html loads this before admin.js instead of
// carrying an inline <script> with the URL baked in. Values come from this
// site's Netlify environment variables (Site configuration > Environment
// variables), not from anything committed to the repo.
export default async (): Promise<Response> => {
  const apiBase = process.env.API_BASE || '';
  const clientSiteUrl = process.env.CLIENT_SITE_URL || '';
  const body = `window.API_BASE = ${JSON.stringify(apiBase)};
window.CLIENT_SITE_URL = ${JSON.stringify(clientSiteUrl)};
`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
};

export const config = { path: '/config.js' };
