import { useSeoMeta } from "@unhead/react";

const NotFound = () => {
  useSeoMeta({
    title: "corkboards.me — 404",
    description: "Page not found.",
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4 text-gray-900 dark:text-gray-100">404</h1>
        <p className="text-xl text-gray-600 dark:text-gray-400 mb-4">Oops! Page not found</p>
        <a href="/" className="text-purple-500 hover:text-purple-700 dark:text-purple-400 dark:hover:text-purple-300 underline">
          Return to Home
        </a>
      </div>
    </div>
  );
};

export default NotFound;
