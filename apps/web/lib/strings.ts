/** Every string the person sees, in one place. Spanish (Argentina). */
export const t = {
  appName: 'Warren',
  tagline: 'Tus movimientos, verificados.',
  home: {
    title: 'Tus movimientos',
    unit: (n: number) => (n === 1 ? 'movimiento registrado' : 'movimientos registrados'),
    empty: 'Todavía no hay movimientos.',
    hello: (name: string) => `Hola, ${name}`,
    erased: 'Esta cuenta fue eliminada.',
    signOut: 'Salir',
    signingOut: 'Saliendo…',
  },
  signIn: {
    title: 'Entrar',
    submit: 'Entrar',
    pending: 'Entrando…',
    switch: '¿No tenés cuenta?',
    switchLink: 'Crear una',
  },
  signUp: {
    title: 'Crear cuenta',
    submit: 'Crear cuenta',
    pending: 'Creando…',
    switch: '¿Ya tenés cuenta?',
    switchLink: 'Entrar',
    hint: 'El registro está abierto solo a personas invitadas.',
  },
  fields: {
    name: 'Nombre',
    email: 'Email',
    password: 'Contraseña',
    passwordHint: (min: number) => `Al menos ${min} caracteres.`,
  },
  errors: {
    invalidCredentials: 'El email o la contraseña no coinciden.',
    signupClosed: 'El registro está cerrado por ahora.',
    exists: 'Ya hay una cuenta con ese email. Entrá con ella.',
    passwordLength: (min: number) => `La contraseña necesita al menos ${min} caracteres.`,
    generic: 'No pudimos completar la acción. Probá de nuevo en un momento.',
  },
} as const
