import { useState } from "react";
import { api, errorMessage } from "../api";
import { ErrorNote } from "../components/bits";

export function ChangePasswordPage({ forced = false, onDone }: { forced?: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const form = (
    <form
      className="auth-card"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (data.get("newPassword") !== data.get("confirm")) {
          setError("The two new passwords do not match.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await api("/auth/password", {
            method: "POST",
            body: { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") },
          });
          setSaved(true);
          onDone();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{forced ? "Choose your password" : "Change password"}</h1>
      <p className="muted">
        {forced
          ? "This account was created from the server configuration. Replace that password before continuing."
          : "Other signed-in sessions of this account will be signed out."}
      </p>
      <label>
        Current password
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label>
        New password <span className="muted">(12+ characters)</span>
        <input name="newPassword" type="password" autoComplete="new-password" minLength={12} required />
      </label>
      <label>
        Repeat new password
        <input name="confirm" type="password" autoComplete="new-password" minLength={12} required />
      </label>
      <ErrorNote message={error} />
      {saved && !forced && <p className="ok-note">Password changed.</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );

  return forced ? <div className="auth-page">{form}</div> : <div className="page narrow">{form}</div>;
}
