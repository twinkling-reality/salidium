"use client";

import { useEffect, useState } from "react";

type Scene = {
  title: string;
  activity: string[];
  response: Array<{ fact: number; text: string }>;
  report: Array<[string, string]>;
};

const scenes: Scene[] = [
  {
    title: "Live session recovery",
    activity: [
      "Inspect replay and reconnect paths",
      "Add cursor-gap preflight",
      "Return resnapshot before streaming",
      "Reconnect from the fresh snapshot",
      "Run stream and timestamp tests",
    ],
    response: [
      {
        fact: 0,
        text: "Implemented safe recovery for live sessions that fall behind. The daemon now checks replay continuity before opening the event stream and returns a typed resnapshot response for sequence gaps, cursors ahead of storage, or a backlog beyond 50,000 events. ",
      },
      {
        fact: 1,
        text: "On the client, that response cancels the old update generation, fetches a fresh session snapshot, and reconnects from the new sequence. Duplicate frames are ignored, while any forward gap forces the same recovery path. ",
      },
      {
        fact: 2,
        text: "I added focused coverage for gap, cursor-ahead, oversized replay, and reconnect behavior, then ran the full test suite, typecheck, and lint successfully. ",
      },
      {
        fact: 3,
        text: "Clients from before this protocol change will not understand the new recovery response and should be upgraded.",
      },
    ],
    report: [
      ["Changed", "Stale sessions now resnapshot."],
      ["Reason", "Large gaps could leave the UI stale."],
      ["Checked", "Stream tests, full suite, types, lint."],
      ["Needs you", "Upgrade older clients."],
    ],
  },
  {
    title: "Legacy evidence repair",
    activity: [
      "Inspect legacy event collisions",
      "Add the schema migration",
      "Queue every known source",
      "Rebuild derived history",
      "Compare migrated and clean replay",
    ],
    response: [
      {
        fact: 0,
        text: "Implemented an offline migration for legacy transcript evidence. On upgrade, Salidium canonicalizes stored timestamps, separates old Claude hook collisions, invalidates derived checkpoints and change logs, and queues every known source for replay without depending on the normal history window. ",
      },
      {
        fact: 1,
        text: "The repair is durable and idempotent: jobs survive restarts, existing event identities stay stable, and repeated records may enrich missing fingerprints instead of being discarded as duplicates. Codex raw evidence now fails closed until its fingerprint is restored. ",
      },
      {
        fact: 2,
        text: "Migration fixtures cover old file dates, missing sources, colliding hook records, hash matches and mismatches, interrupted jobs, and replay equivalence with a clean parse. ",
      },
      {
        fact: 3,
        text: "Source files that no longer exist remain queued and reportable because their original evidence cannot be reconstructed automatically.",
      },
    ],
    report: [
      ["Changed", "Old evidence repairs on upgrade."],
      ["Reason", "Duplicate IDs hid richer records."],
      ["Checked", "Migrated replay matches a clean parse."],
      ["Needs you", "Restore any missing source files."],
    ],
  },
  {
    title: "Browser accessibility",
    activity: [
      "Audit modal keyboard behavior",
      "Add shared focus containment",
      "Test desktop and narrow layouts",
      "Run automated accessibility checks",
      "Verify the full browser matrix",
    ],
    response: [
      {
        fact: 0,
        text: "Added one shared modal-focus system and applied it to the session panel and raw-evidence drawer. Keyboard focus now stays inside the open surface, cycles in both directions, closes on Escape, and returns to the control that actually opened it, including Safari pointer clicks. ",
      },
      {
        fact: 1,
        text: "The background becomes inert while a modal is open. Resizing from mobile to desktop and back preserves the correct state instead of leaving focus in hidden content. Empty evidence groups no longer render blank panels. ",
      },
      {
        fact: 2,
        text: "A real daemon-backed browser suite now checks live session updates, raw drill-through, keyboard containment, focus restoration, responsive resizing, and automated accessibility rules across Chromium, Firefox, and WebKit. ",
      },
      {
        fact: 3,
        text: "The broader product still needs future coverage when new interactive surfaces are added.",
      },
    ],
    report: [
      ["Changed", "Modals now contain and restore focus."],
      ["Reason", "Keyboard focus could escape."],
      ["Checked", "Chromium, Firefox, WebKit, axe."],
      ["Needs you", "Extend tests with new interactions."],
    ],
  },
];

export function DemoTransformation() {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const scene = scenes[sceneIndex];
  const activityStep = reducedMotion ? scene.activity.length : Math.min(step + 1, scene.activity.length);
  const reportStep = reducedMotion ? scene.report.length : Math.min(step + 1, scene.report.length);
  const activeFact = reducedMotion ? -1 : Math.min(step, scene.report.length - 1);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (paused || reducedMotion) return;
    const lastStep = Math.max(scene.activity.length, scene.report.length) - 1;
    const complete = step >= lastStep;
    const timer = window.setTimeout(() => {
      if (complete) {
        setSceneIndex((index) => (index + 1) % scenes.length);
        setStep(0);
      } else {
        setStep((value) => value + 1);
      }
    }, complete ? 2800 : 1050);
    return () => window.clearTimeout(timer);
  }, [paused, reducedMotion, scene.activity.length, scene.report.length, step]);

  return (
    <figure className="transformation">
      <figcaption>
        <h2 id="demo-title">One agent run. Two ways to read it.</h2>
        {!reducedMotion && (
          <button type="button" onClick={() => setPaused((value) => !value)}>
            {paused ? "Play demo" : "Pause demo"}
          </button>
        )}
      </figcaption>

      <div className="work-stream" aria-label={`Agent activity for ${scene.title}`}>
        <div className="work-stream-heading">
          <h3>{scene.title}</h3>
          <span>{activityStep} of {scene.activity.length}</span>
        </div>
        <ol>
          {scene.activity.map((item, index) => (
            <li
              key={item}
              data-state={index < activityStep - 1 ? "done" : index === activityStep - 1 ? "current" : "waiting"}
            >
              <span aria-hidden="true">{index < activityStep - 1 ? "✓" : index === activityStep - 1 ? "•" : ""}</span>
              {item}
            </li>
          ))}
        </ol>
      </div>

      <div className="output-pair">
        <section className="agent-response" aria-labelledby="agent-response-title">
          <h3 id="agent-response-title">Agent response</h3>
          <p>
            {scene.response.map((part) => (
              <span
                key={part.text}
                data-state={part.fact === activeFact ? "current" : part.fact < reportStep ? "read" : "waiting"}
              >
                {part.text}
              </span>
            ))}
          </p>
        </section>

        <section className="salidium-report" aria-labelledby="salidium-report-title">
          <h3 id="salidium-report-title">Salidium report</h3>
          <dl>
            {scene.report.map(([label, value], index) => (
              <div key={label} data-state={index === activeFact ? "current" : index < reportStep ? "read" : "waiting"}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </figure>
  );
}
