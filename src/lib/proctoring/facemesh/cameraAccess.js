export class CameraAccessError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CameraAccessError';
    this.code = code;
  }
}

export async function requestCameraStream(mediaDevices, constraints) {
  if (!mediaDevices?.getUserMedia) {
    throw new CameraAccessError('UNAVAILABLE', 'Camera access is not supported by this browser.');
  }
  try {
    return await mediaDevices.getUserMedia(constraints);
  } catch (error) {
    const denied = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name);
    throw new CameraAccessError(
      denied ? 'PERMISSION_DENIED' : 'START_FAILED',
      denied
        ? 'Camera permission was denied. Allow camera access in the browser and retry.'
        : `The camera could not start${error?.message ? `: ${error.message}` : '.'}`,
      error,
    );
  }
}
