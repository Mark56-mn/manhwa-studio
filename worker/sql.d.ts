/** Migrations are imported as text so the Worker can initialize an empty D1. */
declare module '*.sql' {
  const content: string
  export default content
}
