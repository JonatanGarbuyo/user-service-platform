import { createRoute } from '@hono/zod-openapi';
import { ProblemDetailsSchema } from '../../shared/problem.js';
import {
  CurrentUserSchema,
  LoginRequestSchema,
  LoginResultSchema,
  RegisterRequestSchema,
  RegisteredUserSchema,
  RequestVerificationRequestSchema,
  RequestVerificationResultSchema,
  SignOutResultSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResultSchema,
} from './contract.js';

// Public operation definitions for the identity slice (ticket #10). The
// feature owns paths relative to `/v1/auth`; the application mounts the
// router under `/v1` (ADR-0007). Every failure uses the service-wide RFC 9457
// Problem Details envelope so consumers branch on status + stable `code`.
function problemResponses(description: string): {
  default: {
    content: { 'application/problem+json': { schema: typeof ProblemDetailsSchema } };
    description: string;
  };
} {
  return {
    default: {
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
      description,
    },
  };
}

export const registerRoute = createRoute({
  method: 'post',
  path: '/auth/register',
  operationId: 'registerIdentity',
  summary: 'Register an email identity',
  description:
    'Creates an unverified email/password identity when the deployment policy ' +
    'allows registration, and schedules a verification message through the ' +
    'application mail boundary. The account cannot establish a session until ' +
    'verification succeeds while the policy requires verified email.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: RegisterRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: RegisteredUserSchema } },
      description: 'The identity was created (unverified).',
    },
    ...problemResponses('Registration failure as RFC 9457 Problem Details.'),
  },
});

export const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  operationId: 'loginIdentity',
  summary: 'Establish an email/password session',
  description:
    'Authenticates an email/password identity. While the deployment policy ' +
    'requires verified email, unverified accounts receive a machine-readable ' +
    'verification-required failure instead of a session.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: LoginRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: LoginResultSchema } },
      description: 'Authenticated. The session travels in the Set-Cookie header.',
    },
    ...problemResponses('Authentication failure as RFC 9457 Problem Details.'),
  },
});

export const verifyEmailRoute = createRoute({
  method: 'post',
  path: '/auth/verify-email',
  operationId: 'verifyIdentityEmail',
  summary: 'Complete email verification',
  description:
    'Marks the email address verified from the token delivered by the ' +
    'verification action. Clients extract the `token` query parameter from ' +
    'the action URL and submit it here. Invalid or expired actions fail ' +
    'safely without revealing token material.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: VerifyEmailRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: VerifyEmailResultSchema } },
      description: 'The email address is verified.',
    },
    ...problemResponses('Verification failure as RFC 9457 Problem Details.'),
  },
});

export const requestVerificationRoute = createRoute({
  method: 'post',
  path: '/auth/request-verification',
  operationId: 'requestIdentityVerification',
  summary: 'Request a verification message',
  description:
    'Schedules a fresh verification message for an unverified email address ' +
    'without creating duplicate identities. The response is identical ' +
    'whether or not the address is registered, so it cannot be used for ' +
    'account enumeration.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: RequestVerificationRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: RequestVerificationResultSchema } },
      description: 'The request was accepted.',
    },
    ...problemResponses('Request failure as RFC 9457 Problem Details.'),
  },
});

export const currentUserRoute = createRoute({
  method: 'get',
  path: '/me',
  operationId: 'getCurrentUser',
  summary: 'Resolve the current User',
  description:
    'Returns the stable application-owned current-User representation for ' +
    'the session carried by the request cookies. Anonymous or invalid ' +
    'sessions receive the standard unauthenticated Problem Details response.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: CurrentUserSchema } },
      description: 'The authenticated current User.',
    },
    ...problemResponses('Authentication failure as RFC 9457 Problem Details.'),
  },
});

export const signOutRoute = createRoute({
  method: 'post',
  path: '/auth/sign-out',
  operationId: 'signOutIdentity',
  summary: 'Invalidate the current session',
  description:
    'Invalidates the session carried by the request cookies. Subsequent ' +
    'authenticated-only requests with that session no longer resolve a User.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: SignOutResultSchema } },
      description: 'The session was invalidated.',
    },
    ...problemResponses('Sign-out failure as RFC 9457 Problem Details.'),
  },
});
