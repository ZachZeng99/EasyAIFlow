type ManageDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  fields: Array<{
    key: string;
    label: string;
    value: string;
    placeholder?: string;
  }>;
  toggles?: Array<{
    key: string;
    label: string;
    checked: boolean;
    description?: string;
  }>;
  confirmLabel?: string;
  busy?: boolean;
  onChange: (key: string, value: string) => void;
  onToggleChange?: (key: string, checked: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function ManageDialog({
  open,
  title,
  description,
  fields,
  toggles = [],
  confirmLabel = 'Save',
  busy = false,
  onChange,
  onToggleChange,
  onCancel,
  onSubmit,
}: ManageDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>

        <div className="dialog-body">
          {description ? <p className="dialog-description">{description}</p> : null}
          {fields.map((field) => (
            <label key={field.key} className="dialog-field">
              <span>{field.label}</span>
              <input
                type="text"
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => onChange(field.key, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onSubmit();
                  }
                }}
              />
            </label>
          ))}
          {toggles.map((toggle) => (
            <label key={toggle.key} className="dialog-toggle">
              <input
                type="checkbox"
                checked={toggle.checked}
                onChange={(event) => onToggleChange?.(toggle.key, event.target.checked)}
              />
              <div>
                <strong>{toggle.label}</strong>
                {toggle.description ? <span>{toggle.description}</span> : null}
              </div>
            </label>
          ))}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="dialog-button primary" onClick={onSubmit} disabled={busy}>
            {busy ? 'Saving...' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
