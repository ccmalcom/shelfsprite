import { withApi } from '@/lib/server/http';
import { AuthConfigError, verifyRequestUser } from '@/lib/server/auth';

/**
 * Port of api.py::admin_me. Deliberately ungated: this route IS the admin
 * check, so it must answer for non-admins too. requireAuth is false because
 * withApi would otherwise 401 before the handler runs; the handler resolves the
 * caller itself and mirrors Python's is_admin(), which returns False on any
 * AuthError rather than raising.
 */
export const GET = withApi(
  '/api/admin/me',
  async (req) => {
    let isAdmin = false;
    try {
      const user = await verifyRequestUser(req.headers.get('authorization'));
      isAdmin = user.isAdmin;
    } catch (err) {
      // AuthError means "not signed in", which is simply not an admin. An AuthConfigError is a
      // server fault, not an answer about this caller: rethrow so withApi answers 503 instead of
      // reporting a confident is_admin:false the deployment cannot actually stand behind.
      if (err instanceof AuthConfigError) throw err;
      isAdmin = false;
    }
    return Response.json({ is_admin: isAdmin });
  },
  { requireAuth: false }
);
