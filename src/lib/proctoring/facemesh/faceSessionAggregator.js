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
  maximum_absolute_roll: 0,
  average_tracking_confidence: 0,
  average_head_yaw_degrees: 0,
  average_head_pitch_degrees: 0,
  average_head_roll_degrees: 0,
  final_face_present: 0,
  maximum_face_count: 0,
  maximum_hand_count: 0,
  observation_count: 0,
  tracking_sample_count: 0,
  pose_sample_count: 0,
  hand_sample_count: 0,
});

export class FaceSessionAggregator {
  constructor() {
    this.summary = { ...EMPTY };
    this.trackingTotal = 0;
    this.trackingSamples = 0;
    this.poseTotals = { yaw: 0, pitch: 0, roll: 0 };
    this.poseSamples = 0;
    this.handSamples = 0;
    this.finalizedIncidentIds = new Set();
  }

  observe(observation) {
    this.summary.observation_count += 1;
    this.summary.final_face_present = observation?.facePresent === true ? 1 : 0;
    const faceCount = Number(observation?.faceCount);
    if (Number.isFinite(faceCount)) {
      this.summary.maximum_face_count = Math.max(
        this.summary.maximum_face_count,
        Math.min(2, Math.max(0, Math.round(faceCount))),
      );
    }
    const hasHandCount = observation?.handCount !== null && observation?.handCount !== undefined;
    const handCount = Number(observation?.handCount);
    if (observation?.handTrackingAvailable === true && hasHandCount && Number.isFinite(handCount)) {
      this.handSamples += 1;
      this.summary.hand_sample_count = this.handSamples;
      this.summary.maximum_hand_count = Math.max(
        this.summary.maximum_hand_count,
        Math.min(3, Math.max(0, Math.round(handCount))),
      );
    }
    const hasTrackingQuality = observation?.trackingQuality !== null
      && observation?.trackingQuality !== undefined;
    const quality = Number(observation?.trackingQuality);
    if (hasTrackingQuality && Number.isFinite(quality)) {
      this.trackingTotal += quality;
      this.trackingSamples += 1;
      this.summary.tracking_sample_count = this.trackingSamples;
      this.summary.average_tracking_confidence = this.trackingTotal / this.trackingSamples;
    }
    const pose = observation?.relativePose;
    if (pose) {
      const hasCompletePose = ['yaw', 'pitch', 'roll'].every(
        key => pose[key] !== null && pose[key] !== undefined,
      );
      const yaw = Number(pose.yaw);
      const pitch = Number(pose.pitch);
      const roll = Number(pose.roll);
      if (hasCompletePose && [yaw, pitch, roll].every(Number.isFinite)) {
        this.poseTotals.yaw += yaw;
        this.poseTotals.pitch += pitch;
        this.poseTotals.roll += roll;
        this.poseSamples += 1;
        this.summary.pose_sample_count = this.poseSamples;
        this.summary.average_head_yaw_degrees = this.poseTotals.yaw / this.poseSamples;
        this.summary.average_head_pitch_degrees = this.poseTotals.pitch / this.poseSamples;
        this.summary.average_head_roll_degrees = this.poseTotals.roll / this.poseSamples;
        this.summary.maximum_absolute_yaw = Math.max(this.summary.maximum_absolute_yaw, Math.abs(yaw));
        this.summary.maximum_absolute_pitch = Math.max(this.summary.maximum_absolute_pitch, Math.abs(pitch));
        this.summary.maximum_absolute_roll = Math.max(this.summary.maximum_absolute_roll, Math.abs(roll));
      }
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
    return {
      ...Object.fromEntries(Object.entries(this.summary).map(([key, value]) => [
        key,
        typeof value === 'number' ? Math.round(value * 1000) / 1000 : value,
      ])),
      feature_contract_version: 'rf-session-summary-v1',
      random_forest_compatible: this.trackingSamples > 0 && this.poseSamples > 0 && this.handSamples > 0,
    };
  }
}
