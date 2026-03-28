import type { SessionPermissionRequest } from '../data/sessionInteraction';

type InlinePermissionCardProps = {
  request: SessionPermissionRequest;
  busy: boolean;
  onGrant: () => void;
  onDeny: () => void;
};

export function InlinePermissionCard({ request, busy, onGrant, onDeny }: InlinePermissionCardProps) {
  const interactive = Boolean(request.requestId);

  return (
    <article className="inline-interaction-card">
      <div className="dialog-head">
        <h2>Permission Request</h2>
      </div>
      <div className="dialog-body">
        <p className="dialog-description">Claude requested permission to access this path:</p>
        <pre className="message-body">{request.path}</pre>
        <p className="dialog-description">
          {request.sensitive
            ? 'This path is treated as sensitive. Granting access will add persistent allow rules to the project-local Claude settings.'
            : 'Granting access will add persistent allow rules to the project-local Claude settings.'}
        </p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="dialog-button secondary" onClick={onDeny} disabled={busy}>
          {interactive ? 'Deny' : 'Cancel'}
        </button>
        <button type="button" className="dialog-button primary" onClick={onGrant} disabled={busy}>
          {busy ? 'Granting...' : interactive ? 'Allow' : 'Always Allow Path'}
        </button>
      </div>
    </article>
  );
}
