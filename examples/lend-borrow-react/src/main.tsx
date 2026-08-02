import { useCallback, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  useAval,
  type AvalSources
} from "@pixel-point/aval-react";

import "./styles.css";

const SOURCES = Object.freeze({
  vp9: "/lend-borrow/vp9.avl",
  h265: "/lend-borrow/h265.avl"
}) satisfies AvalSources;

const INITIAL_BACKGROUND = "#000000";

function App() {
  const [backgroundColor, setBackgroundColor] = useState(INITIAL_BACKGROUND);
  const [activationError, setActivationError] = useState<string | null>(null);
  const { aval, AvalComponent } = useAval({
    sources: SOURCES,
    state: "idle",
    autoplay: true,
    autoBind: false
  });

  const fatalFailure = aval.lastError?.fatal === true
    ? aval.lastError.failure
    : null;
  const unavailable = fatalFailure !== null ||
    aval.readiness === "disposed" ||
    aval.readiness === "error";
  const interactive = aval.readiness === "interactiveReady";
  const active = aval.visualState === "active";
  const queued = aval.requestedState === "active" && !active;
  const busy = queued || active || aval.isTransitioning;
  const status = unavailable
    ? "Animation unavailable"
    : aval.readiness === "staticReady"
      ? "Animation is inactive in this browser"
      : queued
        ? "Activation queued for the end of the idle loop"
        : active
          ? "Active animation playing"
          : interactive
            ? "Animation ready"
            : "Loading animation";
  const visibleError = activationError ?? fatalFailure?.message ?? null;
  const pageStyle = {
    "--page-background": backgroundColor
  } as CSSProperties;

  const activate = useCallback(() => {
    setActivationError(null);
    void aval.setState("active").catch(() => {
      setActivationError("The animation could not be activated.");
    });
  }, [aval]);

  return (
    <main className="demo" style={pageStyle}>
      <div className="motion-stage">
        <AvalComponent
          className="lend-borrow-player"
          width={3840}
          height={670}
          role="img"
          aria-label="Animated lend and borrow interface"
          aria-describedby="motion-status"
          aria-hidden={unavailable}
        />
        {visibleError !== null ? (
          <p className="error-message" role="alert">
            {visibleError}
          </p>
        ) : null}
      </div>

      <div className="controls" aria-label="Animation preview controls">
        <button
          className="activate-button"
          type="button"
          onClick={activate}
          disabled={!interactive || busy || unavailable}
        >
          {queued ? "Queued" : active ? "Active" : "Activate"}
        </button>

        <div className="background-control">
          <label htmlFor="background-color">Background</label>
          <input
            id="background-color"
            name="background-color"
            type="color"
            value={backgroundColor}
            onChange={(event) => setBackgroundColor(event.currentTarget.value)}
            title="Choose page background color"
          />
        </div>
      </div>

      <p id="motion-status" className="visually-hidden" aria-live="polite">
        {status}
      </p>
    </main>
  );
}

const root = document.querySelector<HTMLElement>("#root");
if (root === null) throw new Error("React example root is missing");
createRoot(root).render(<App />);
