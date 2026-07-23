import { useSeoMeta } from '@unhead/react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DMMessagingInterface } from '@/components/dm/DMMessagingInterface';

const Messages = () => {
  const navigate = useNavigate();
  useSeoMeta({
    title: 'corkboards.me — Messages',
    description: 'Private encrypted messaging',
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-4 h-screen flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')} aria-label="Back to corkboards">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl font-semibold">Messages</h1>
        </div>

        <DMMessagingInterface className="flex-1" />
      </div>
    </div>
  );
};

export default Messages;
