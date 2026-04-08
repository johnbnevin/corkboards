import { useSeoMeta } from '@unhead/react';

const Index = () => {
  useSeoMeta({
    title: 'corkboards.me',
    description: 'A private social feed reader and builder',
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4 text-gray-900 dark:text-gray-100">
          corkboards.me
        </h1>
        <p className="text-xl text-gray-600 dark:text-gray-400">
          Build social feeds by arranging posts from friends or news sources like notecards on a personalized corkboard, or make your own — uncensorable, and private.
        </p>
      </div>
    </div>
  );
};

export default Index;
