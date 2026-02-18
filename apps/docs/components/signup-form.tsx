"use client";

import { useState, type FormEvent } from "react";

const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbw17ppbh2l-VjrIyFjAmI7aqFjJZSuB-ycN8iAOzyM8q1Eh07X9leKhvSsxbzfR7IY/exec";

export function SignupForm({ label = "Get Updates" }: { label?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success">(
    "idle"
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setStatus("submitting");

    const iframe = document.createElement("iframe");
    iframe.name = "gitmem-signup-frame";
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = APPS_SCRIPT_URL;
    form.target = "gitmem-signup-frame";

    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "email";
    input.value = email;
    form.appendChild(input);

    document.body.appendChild(form);
    form.submit();

    setTimeout(() => {
      form.remove();
      iframe.remove();
      setStatus("success");
      setEmail("");
    }, 1500);
  };

  return (
    <form onSubmit={handleSubmit} className="signup-inline">
      <div className="signup-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          disabled={status !== "idle"}
          required
        />
        <button
          type="submit"
          disabled={status !== "idle"}
          className={status === "success" ? "success" : ""}
        >
          {status === "idle" && label}
          {status === "submitting" && "Joining..."}
          {status === "success" && "\u2713 Subscribed"}
        </button>
      </div>
      {status === "success" && (
        <p className="signup-ok">You're in. Updates only when they matter.</p>
      )}
    </form>
  );
}
