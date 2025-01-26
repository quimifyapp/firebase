const functions = require('firebase-functions');
const admin = require('firebase-admin');
const OpenAI = require('openai');

admin.initializeApp();
const db = admin.firestore();

const openai = new OpenAI({
  apiKey: functions.config().openai.key
});

exports.extractTextFromImage = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onCall(async (data, context) => {
    try {
      const { imageBase64 } = data;

      if (!imageBase64) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'The function must be called with imageBase64.'
        );
      }

      const base64Image = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a text extraction tool. Your only job is to read and return the exact text from images. Do not add any explanations, descriptions, or additional context. Just return the text exactly as it appears in the image."
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract and return only the text from this image, exactly as it appears." },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1000,
      });

      return {
        success: true,
        text: response.choices[0].message.content,
      };
    } catch (error) {
      console.error('Error:', error);
      throw new functions.https.HttpsError('internal', error.message);
    }
  });

  exports.processChat = functions
  .region('us-central1')
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onCall(async (data, context) => {
    const maxNumberOfMessages = 20;

    // Ensure user is authenticated
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'The function must be called while authenticated.'
      );
    }

    const userId = context.auth.uid;
    const { message, imageBase64, messageType = 'text' } = data;

    // Validate input based on message type
    if (messageType === 'text' && !message) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Text messages must include a message.'
      );
    }

    if (messageType === 'image' && !imageBase64) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Image messages must include an image.'
      );
    }

    try {
      // Reference to user's chat collection
      const chatRef = db.collection('chatbot').doc(userId);
      const messagesRef = chatRef.collection('messages');

      // Add user message
      const userMessageDoc = await messagesRef.add({
        content: message || '',
        messageType,
        isUser: true,
        timestamp: admin.firestore.Timestamp.now(),
        status: 'delivered'
      });

      // Add placeholder for AI response
      const aiMessageDoc = await messagesRef.add({
        content: '',
        isUser: false,
        timestamp: admin.firestore.Timestamp.now(),
        status: 'processing'
      });

      // Get last 20 messages for context
      const lastMessages = await messagesRef
        .orderBy('timestamp', 'desc')
        .limit(maxNumberOfMessages)
        .get();

      // Format messages for OpenAI
      const messages = lastMessages.docs
        .map(doc => doc.data())
        .reverse()
        .map(msg => {
          if (msg.messageType === 'image' && msg.imageBase64) {
            // For the current message with image, include both image and text
            return {
              role: msg.isUser ? 'user' : 'assistant',
              content: [
                {
                  type: "text",
                  text: msg.content || "What do you see in this image?"
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${msg.imageBase64.replace(/^data:image\/\w+;base64,/, '')}`
                  }
                }
              ]
            };
          } else {
            // For regular messages or past image messages (without image data)
            return {
              role: msg.isUser ? 'user' : 'assistant',
              content: msg.content
            };
          }
        });

      // Add system message for context
      messages.unshift({
        role: 'system',
        content: 'You are Atomic, an AI chemistry teacher integrated into Quimify, a mobile app founded in 2020 by Matthew S. Horne and Pablo Asenjo Navas-Parejo, two young entrepreneurs from Málaga, Spain. Quimify helps over 1 million students worldwide, primarily Spanish-speaking high school students from Spain and Latin America, understand science concepts, especially chemistry. When asked about yourself, your creators, or Quimify, you should answer with the previous context given to you and refer to their social media which are: TikTok: @quimify Instagram: @quimifyapp, @matt.hornne, @pabloasenjo3 Keep your responses concise, professional, and focused on the specific question or problem the student presents. Avoid unnecessary information to ensure your replies fit within a 500-token limit. While your primary audience is Spanish-speaking students, adjust your language and context to suit the users needs. Always aim for clarity and suitability for a high school student audience.'
      });

      // Get response from OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
      });

      const aiResponse = completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';

      // Update AI message in Firestore
      await aiMessageDoc.update({
        content: aiResponse,
        status: 'completed',
        timestamp: admin.firestore.Timestamp.now()
      });

      // Update metadata
      await chatRef.set({
        last_interaction: admin.firestore.Timestamp.now(),
        total_messages: admin.firestore.FieldValue.increment(2)
      }, { merge: true });

      return {
        success: true,
        messageId: aiMessageDoc.id
      };

    } catch (error) {
      console.error('Error processing chat:', error);

      // Update AI message with error status if it exists
      if (aiMessageDoc) {
        await aiMessageDoc.update({
          status: 'error',
          content: 'Sorry, an error occurred while processing your message.'
        });
      }

      throw new functions.https.HttpsError('internal', error.message);
    }
  });