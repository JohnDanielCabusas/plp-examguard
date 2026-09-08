const EMPTY = Object.freeze({
  face_absent_count: 0,
  face_absent_total_seconds: 0,
  head_turn_count: 0,
  head_turn_total_seconds: 0,
  looking_down_count: 0,
  looking_down_total_seconds: 0,
  repeated_looking_away_count: 0,
  face_occlusion_count: 0,
  tracking_loss_count: 0,
  maximum_absolute_yaw: 0,
  maximum_absolute_pitch: 0,
  average_tracking_confidence: 0,
});

export class FaceSessionAggregator {
  constructor() {
    this.summary = { ...EMPTY };
    this.trackingTotal = 0;
    this.trackingSamples = 0;
    this.finalizedIncidentIds = new Set();
  }

  observe(observation) {
    const quality = Number(observation?.trackingQuality);
    if (Number.isFinite(quality)) {
      this.trackingTotal += quality;
      this.trackingSamples += 1;
      this.summary.average_tracking_confidence = this.trackingTotal / this.trackingSamples;
    }
    const pose = observation?.relativePose;
    if (pose) {
      this.summary.maximum_absolute_yaw = Math.max(this.summary.maximum_absolute_yaw, Math.abs(Number(pose.yaw || 0)));
      this.summary.maximum_absolute_pitch = Math.max(this.summary.maximum_absolute_pitch, Math.abs(Number(pose.pitch || 0)));
    }
  }

  consume(event) {
    if (event?.kind !== 'incident' || event.phase !== 'end' || this.finalizedIncidentIds.has(event.incidentId)) return;
    this.finalizedIncidentIds.add(event.incidentId);
    const seconds = Math.max(0, Number(event.durationMs || 0) / 1000);
    if (event.eventType === 'FACE_ABSENT') {
      this.summary.face_absent_count += 1;
      this.summary.face_absent_total_seconds += seconds;
    } else if (event.eventType === 'SUSTAINED_HEAD_TURN') {
      this.summary.head_turn_count += 1;
      this.summary.head_turn_total_seconds += seconds;
    } else if (event.eventType === 'SUSTAINED_LOOKING_DOWN') {
      this.summary.looking_down_count += 1;
      this.summary.looking_down_total_seconds += seconds;
    } else if (event.eventType === 'REPEATED_LOOKING_AWAY') {
      this.summary.repeated_looking_away_count += 1;
    } else if (event.eventType === 'FACE_OCCLUDED') {
      this.summary.face_occlusion_count += 1;
    } else if (event.eventType === 'FACE_TRACKING_UNSTABLE') {
      this.summary.tracking_loss_count += 1;
    }
  }

  snapshot() {
    return Object.fromEntries(Object.entries(this.summary).map(([key, value]) => [
      key,
      typeof value === 'number' ? Math.round(value * 1000) / 1000 : value,
    ]));
  }
}
