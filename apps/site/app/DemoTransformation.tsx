export function DemoTransformation() {
  return (
    <figure className="translation">
      <figcaption>See the cause and the fix without reading every line.</figcaption>

      <div
        className="translation-stage"
        role="img"
        aria-label="Salidium highlights evidence in a verbose agent response and maps it into Why and How explanations. Evidence was lost because the cursor advanced before storage was durable. The fix is to queue the record, flush storage, then advance the cursor."
      >
        <div className="translation-source" aria-hidden="true">
          <span className="translation-label">Agent response</span>
          <p>
            I traced the missing session state through SessionCoordinator and transcriptTailer. The
            coordinator batches canonical events for 40 ms, but the tailer{" "}
            <mark className="extract-cause">
              persists cursorOffset before the storage transaction commits
            </mark>
            . If the process{" "}
            <mark className="extract-failure">terminates inside that gap</mark>, recovery resumes after
            an event the database never received, so the reconstructed session looks complete while
            evidence is actually missing.
          </p>
          <p>
            I changed the durability boundary so ingestion now{" "}
            <mark className="extract-how">
              queues the record, waits for the durable storage flush, and only then advances the
              cursor
            </mark>
            . That keeps replay deterministic after an interruption without changing the event
            schema.
          </p>
        </div>

        <div className="translation-result" aria-hidden="true">
          <span className="translation-label">Salidium</span>
          <section className="extracted-why">
            <h3>Why</h3>
            <p>Evidence was lost because the cursor advanced before storage was durable.</p>
          </section>
          <section className="extracted-how">
            <h3>How</h3>
            <p>Queue the record. Flush storage. Then advance the cursor.</p>
          </section>
        </div>
      </div>
    </figure>
  );
}
