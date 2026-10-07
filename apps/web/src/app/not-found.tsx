import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">Not found</h1>
        <Link href="/" className="mt-4 inline-block text-sm underline underline-offset-4">
          Search
        </Link>
      </div>
    </main>
  );
}
