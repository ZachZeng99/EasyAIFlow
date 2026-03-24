type PermissionDialogProps = {
  open: boolean;
  path: string;
  sensitive: boolean;
  interactive?: boolean;
  busy: boolean;
  onCancel: () => void;
  onGrant: () => void;
};

export function PermissionDialog({
  open,
  path,
  sensitive,
  interactive = false,
  busy,
  onCancel,
  onGrant,
}: PermissionDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="Grant file access"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>Grant File Access</h2>
        </div>
        <div className="dialog-body">
          <p className="dialog-description">Claude requested permission to modify this path:</p>
          <pre className="message-body">{path}</pre>
          <p className="dialog-description">
            {sensitive
              ? 'This path is treated as sensitive. Granting access will add persistent allow rules to the project-local Claude settings.'
              : 'Granting access will add persistent allow rules to the project-local Claude settings.'}
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-button secondary" onClick={onCancel}>
            {interactive ? 'Deny' : 'Cancel'}
          </button>
          <button type="button" className="dialog-button primary" onClick={onGrant} disabled={busy}>
            {busy ? 'Granting...' : interactive ? 'Allow' : 'Always Allow Path'}
          </button>
        </div>
      </section>
    </div>
  );
}
