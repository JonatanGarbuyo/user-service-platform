// Adapted from Marmelab Shadcn Admin Kit v2.0.0 LoginPage (MIT): Spanish
// product copy and inline safe failures replace its demo branding/credentials.
import { useState } from 'react';
import { email, Form, required, useLogin } from 'ra-core';
import type { FieldValues, SubmitHandler } from 'react-hook-form';
import { TextInput } from './kit/components/admin/text-input.js';
import { Button } from './kit/components/ui/button.js';
import { ApiError } from './api.js';

export function LoginPage() {
  const submitLogin = useLogin();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const handleSubmit: SubmitHandler<FieldValues> = async (values) => {
    setPending(true);
    setFailure(null);
    try {
      const loginEmail: unknown = values.email;
      const password: unknown = values.password;
      await submitLogin({ email: loginEmail, password }, '/');
    } catch (error) {
      setFailure(
        error instanceof ApiError
          ? error.message
          : 'No pudimos iniciar sesión. Inténtalo de nuevo.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">USER SERVICE</p>
        <h1 id="login-title">Administración</h1>
        <p className="auth-description">Inicia sesión con tu cuenta de administrador verificada.</p>
        <Form onSubmit={handleSubmit} className="login-form">
          <TextInput
            source="email"
            type="email"
            label="Correo electrónico"
            autoComplete="username"
            validate={[required(), email()]}
            disabled={pending}
          />
          <TextInput
            source="password"
            type="password"
            label="Contraseña"
            autoComplete="current-password"
            validate={required()}
            disabled={pending}
          />
          {failure !== null && (
            <p role="alert" className="failure-message">
              {failure}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Iniciando sesión…' : 'Iniciar sesión'}
          </Button>
        </Form>
        <p className="auth-footer">El acceso se valida en el servicio con tu sesión actual.</p>
      </section>
    </main>
  );
}
