'use strict';
const { ApiError } = require('./errors');

const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[A-Za-z0-9-]{8,64}$/;

function stripControl(s) {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function bad(message) {
  return new ApiError(400, 'INVALID_INPUT', message);
}

function isValidId(id) {
  return typeof id === 'string' && ID.test(id);
}

/** Project name: 1–60 characters. */
function cleanName(value) {
  if (typeof value !== 'string') throw bad('Please enter a name.');
  const s = stripControl(value).replace(/\s+/g, ' ').trim();
  if (!s) throw bad('Please enter a name.');
  if (s.length > 60) throw bad('That name is too long (60 characters maximum).');
  return s;
}

/** Validates the editable app settings. `base` supplies values that are not being changed. */
function cleanConfig(input, base) {
  if (input === undefined) return { ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Invalid app settings.');
  const out = { ...base };

  if (input.appName !== undefined) {
    if (typeof input.appName !== 'string') throw bad('App name must be text.');
    const s = stripControl(input.appName).replace(/\s+/g, ' ').trim();
    if (!s) throw bad('The app name cannot be empty.');
    if (s.length > 30) throw bad('The app name is too long (30 characters maximum).');
    out.appName = s;
  }
  if (input.heading !== undefined) {
    if (typeof input.heading !== 'string') throw bad('Heading must be text.');
    const s = stripControl(input.heading).trim();
    if (s.length > 80) throw bad('The heading is too long (80 characters maximum).');
    out.heading = s;
  }
  if (input.message !== undefined) {
    if (typeof input.message !== 'string') throw bad('Message must be text.');
    // Keep line breaks in the message, strip other control characters.
    const s = input.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
    if (s.length > 500) throw bad('The message is too long (500 characters maximum).');
    out.message = s;
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || !COLOR.test(input.color)) throw bad('Pick a valid color.');
    out.color = input.color.toLowerCase();
  }
  return out;
}

module.exports = { cleanName, cleanConfig, isValidId };
