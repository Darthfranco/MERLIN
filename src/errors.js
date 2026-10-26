export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function objectArgs(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    throw new AppError('Invalid arguments. Unexpected fields are not allowed.');
  }
}

export function timeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) {
    throw new AppError('An explicit IANA time zone is required.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { throw new AppError('Choose a valid IANA time zone.'); }
  return value;
}

export function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new AppError('A valid request/session identifier is required.');
  }
  return value;
}
