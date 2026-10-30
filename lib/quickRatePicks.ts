/**
 * The quick-rate grid's starter titles: a fixed, hand-picked list of widely read books per
 * genre. These are lookup inputs only. Each pair is resolved through the catalog with the
 * strict title-and-author rule (POST /api/books/match, mode `strict`), only resolved catalog
 * records are shown or added, and a pair that does not resolve is dropped. Nothing here is
 * generated, and Claude is not involved.
 */

export interface QuickRatePick {
  title: string;
  author: string;
}

export interface QuickRateGenre {
  id: string;
  label: string;
  /**
   * Best known first. The first 20 fill the grid; the rest stand in for picks a reader has
   * already shelved or the catalog cannot resolve, so the grid still fills.
   */
  picks: QuickRatePick[];
}

/** How many genres a reader picks, and the most tiles the grid shows. */
export const QUICK_RATE_MIN_GENRES = 2;
export const QUICK_RATE_MAX_GENRES = 3;
export const QUICK_RATE_MAX_TILES = 40;

const p = (title: string, author: string): QuickRatePick => ({ title, author });

export const QUICK_RATE_GENRES: QuickRateGenre[] = [
  {
    id: 'literary',
    label: 'Literary fiction',
    picks: [
      p('Beloved', 'Toni Morrison'),
      p('The Remains of the Day', 'Kazuo Ishiguro'),
      p('Never Let Me Go', 'Kazuo Ishiguro'),
      p('The Road', 'Cormac McCarthy'),
      p('Gilead', 'Marilynne Robinson'),
      p('The Secret History', 'Donna Tartt'),
      p('The Goldfinch', 'Donna Tartt'),
      p('A Little Life', 'Hanya Yanagihara'),
      p('Normal People', 'Sally Rooney'),
      p('The Kite Runner', 'Khaled Hosseini'),
      p('Life of Pi', 'Yann Martel'),
      p('Atonement', 'Ian McEwan'),
      p('The Corrections', 'Jonathan Franzen'),
      p('Pachinko', 'Min Jin Lee'),
      p('The Underground Railroad', 'Colson Whitehead'),
      p('Lincoln in the Bardo', 'George Saunders'),
      p('To Kill a Mockingbird', 'Harper Lee'),
      p('The Great Gatsby', 'F. Scott Fitzgerald'),
      p('Olive Kitteridge', 'Elizabeth Strout'),
      p('The God of Small Things', 'Arundhati Roy'),
      p('The Bell Jar', 'Sylvia Plath'),
      p('Things Fall Apart', 'Chinua Achebe'),
      p('Middlemarch', 'George Eliot'),
      p('One Hundred Years of Solitude', 'Gabriel García Márquez'),
      p('The Catcher in the Rye', 'J. D. Salinger'),
      p('Of Mice and Men', 'John Steinbeck'),
      p('Klara and the Sun', 'Kazuo Ishiguro'),
      p('A Thousand Splendid Suns', 'Khaled Hosseini'),
    ],
  },
  {
    id: 'scifi',
    label: 'Science fiction',
    picks: [
      p('Dune', 'Frank Herbert'),
      p('The Left Hand of Darkness', 'Ursula K. Le Guin'),
      p('Neuromancer', 'William Gibson'),
      p("Ender's Game", 'Orson Scott Card'),
      p('The Martian', 'Andy Weir'),
      p('Project Hail Mary', 'Andy Weir'),
      p("The Hitchhiker's Guide to the Galaxy", 'Douglas Adams'),
      p('Foundation', 'Isaac Asimov'),
      p('Hyperion', 'Dan Simmons'),
      p('The Three-Body Problem', 'Cixin Liu'),
      p('Leviathan Wakes', 'James S. A. Corey'),
      p('Snow Crash', 'Neal Stephenson'),
      p('Do Androids Dream of Electric Sheep?', 'Philip K. Dick'),
      p('Fahrenheit 451', 'Ray Bradbury'),
      p('Brave New World', 'Aldous Huxley'),
      p('Nineteen Eighty-Four', 'George Orwell'),
      p("The Handmaid's Tale", 'Margaret Atwood'),
      p('Children of Time', 'Adrian Tchaikovsky'),
      p('A Memory Called Empire', 'Arkady Martine'),
      p('Station Eleven', 'Emily St. John Mandel'),
      p('Red Rising', 'Pierce Brown'),
      p('The Dispossessed', 'Ursula K. Le Guin'),
      p('Ready Player One', 'Ernest Cline'),
      p('Slaughterhouse-Five', 'Kurt Vonnegut'),
      p('Dark Matter', 'Blake Crouch'),
      p('Altered Carbon', 'Richard K. Morgan'),
      p('The Long Way to a Small, Angry Planet', 'Becky Chambers'),
      p('Ancillary Justice', 'Ann Leckie'),
    ],
  },
  {
    id: 'fantasy',
    label: 'Fantasy',
    picks: [
      p('The Hobbit', 'J. R. R. Tolkien'),
      p('The Fellowship of the Ring', 'J. R. R. Tolkien'),
      p('A Game of Thrones', 'George R. R. Martin'),
      p('The Name of the Wind', 'Patrick Rothfuss'),
      p('Mistborn: The Final Empire', 'Brandon Sanderson'),
      p('The Way of Kings', 'Brandon Sanderson'),
      p("Harry Potter and the Sorcerer's Stone", 'J. K. Rowling'),
      p('A Wizard of Earthsea', 'Ursula K. Le Guin'),
      p('The Lies of Locke Lamora', 'Scott Lynch'),
      p('Circe', 'Madeline Miller'),
      p('The Song of Achilles', 'Madeline Miller'),
      p('American Gods', 'Neil Gaiman'),
      p('Jonathan Strange & Mr Norrell', 'Susanna Clarke'),
      p('Piranesi', 'Susanna Clarke'),
      p('The Priory of the Orange Tree', 'Samantha Shannon'),
      p('The Fifth Season', 'N. K. Jemisin'),
      p('The Night Circus', 'Erin Morgenstern'),
      p('Uprooted', 'Naomi Novik'),
      p('The Colour of Magic', 'Terry Pratchett'),
      p('The Eye of the World', 'Robert Jordan'),
      p('The Lion, the Witch and the Wardrobe', 'C. S. Lewis'),
      p('The Golden Compass', 'Philip Pullman'),
      p('Good Omens', 'Terry Pratchett'),
      p('Stardust', 'Neil Gaiman'),
      p('Six of Crows', 'Leigh Bardugo'),
      p('The House in the Cerulean Sea', 'TJ Klune'),
      p('The Blade Itself', 'Joe Abercrombie'),
      p('A Court of Thorns and Roses', 'Sarah J. Maas'),
    ],
  },
  {
    id: 'mystery',
    label: 'Mystery and thriller',
    picks: [
      p('Gone Girl', 'Gillian Flynn'),
      p('The Girl with the Dragon Tattoo', 'Stieg Larsson'),
      p('And Then There Were None', 'Agatha Christie'),
      p('Murder on the Orient Express', 'Agatha Christie'),
      p('The Big Sleep', 'Raymond Chandler'),
      p('The Da Vinci Code', 'Dan Brown'),
      p('Big Little Lies', 'Liane Moriarty'),
      p('The Silent Patient', 'Alex Michaelides'),
      p('In the Woods', 'Tana French'),
      p('The Talented Mr. Ripley', 'Patricia Highsmith'),
      p('Rebecca', 'Daphne du Maurier'),
      p('The Thursday Murder Club', 'Richard Osman'),
      p('The Girl on the Train', 'Paula Hawkins'),
      p('The Hound of the Baskervilles', 'Arthur Conan Doyle'),
      p('Still Life', 'Louise Penny'),
      p('The Silence of the Lambs', 'Thomas Harris'),
      p("The Cuckoo's Calling", 'Robert Galbraith'),
      p('Sharp Objects', 'Gillian Flynn'),
      p('The Name of the Rose', 'Umberto Eco'),
      p('Magpie Murders', 'Anthony Horowitz'),
      p('The Murder of Roger Ackroyd', 'Agatha Christie'),
      p('The Maltese Falcon', 'Dashiell Hammett'),
      p('The Firm', 'John Grisham'),
      p('Mystic River', 'Dennis Lehane'),
      p('The Bourne Identity', 'Robert Ludlum'),
      p("The No. 1 Ladies' Detective Agency", 'Alexander McCall Smith'),
      p('The Woman in the Window', 'A. J. Finn'),
      p('The Guest List', 'Lucy Foley'),
    ],
  },
  {
    id: 'romance',
    label: 'Romance',
    picks: [
      p('Pride and Prejudice', 'Jane Austen'),
      p('Persuasion', 'Jane Austen'),
      p('Jane Eyre', 'Charlotte Brontë'),
      p('Outlander', 'Diana Gabaldon'),
      p('The Notebook', 'Nicholas Sparks'),
      p('Me Before You', 'Jojo Moyes'),
      p('The Hating Game', 'Sally Thorne'),
      p('Red, White & Royal Blue', 'Casey McQuiston'),
      p('Beach Read', 'Emily Henry'),
      p('People We Meet on Vacation', 'Emily Henry'),
      p('Book Lovers', 'Emily Henry'),
      p('The Kiss Quotient', 'Helen Hoang'),
      p('It Ends with Us', 'Colleen Hoover'),
      p('The Seven Husbands of Evelyn Hugo', 'Taylor Jenkins Reid'),
      p("The Time Traveler's Wife", 'Audrey Niffenegger'),
      p('The Duke and I', 'Julia Quinn'),
      p('The Flatshare', "Beth O'Leary"),
      p('The Love Hypothesis', 'Ali Hazelwood'),
      p('The Rosie Project', 'Graeme Simsion'),
      p("Bridget Jones's Diary", 'Helen Fielding'),
      p('Sense and Sensibility', 'Jane Austen'),
      p('Emma', 'Jane Austen'),
      p('Wuthering Heights', 'Emily Brontë'),
      p('North and South', 'Elizabeth Gaskell'),
      p('Eleanor & Park', 'Rainbow Rowell'),
      p('Happy Place', 'Emily Henry'),
      p('The Wedding Date', 'Jasmine Guillory'),
      p('Get a Life, Chloe Brown', 'Talia Hibbert'),
    ],
  },
  {
    id: 'historical',
    label: 'Historical fiction',
    picks: [
      p('All the Light We Cannot See', 'Anthony Doerr'),
      p('The Book Thief', 'Markus Zusak'),
      p('Wolf Hall', 'Hilary Mantel'),
      p('The Nightingale', 'Kristin Hannah'),
      p('The Pillars of the Earth', 'Ken Follett'),
      p('Lonesome Dove', 'Larry McMurtry'),
      p('The Help', 'Kathryn Stockett'),
      p('Girl with a Pearl Earring', 'Tracy Chevalier'),
      p('The Other Boleyn Girl', 'Philippa Gregory'),
      p('Shogun', 'James Clavell'),
      p('Hamnet', "Maggie O'Farrell"),
      p('Memoirs of a Geisha', 'Arthur Golden'),
      p('The Guernsey Literary and Potato Peel Pie Society', 'Mary Ann Shaffer'),
      p('Homegoing', 'Yaa Gyasi'),
      p('Cold Mountain', 'Charles Frazier'),
      p('A Gentleman in Moscow', 'Amor Towles'),
      p('The Last Kingdom', 'Bernard Cornwell'),
      p('The Alice Network', 'Kate Quinn'),
      p('Where the Crawdads Sing', 'Delia Owens'),
      p('War and Peace', 'Leo Tolstoy'),
      p('Gone with the Wind', 'Margaret Mitchell'),
      p('Bring Up the Bodies', 'Hilary Mantel'),
      p('The Thorn Birds', 'Colleen McCullough'),
      p('I, Claudius', 'Robert Graves'),
      p('Lilac Girls', 'Martha Hall Kelly'),
      p('The Covenant of Water', 'Abraham Verghese'),
      p('The Tattooist of Auschwitz', 'Heather Morris'),
      p('The Paris Library', 'Janet Skeslien Charles'),
    ],
  },
  {
    id: 'horror',
    label: 'Horror',
    picks: [
      p('The Shining', 'Stephen King'),
      p('It', 'Stephen King'),
      p('Pet Sematary', 'Stephen King'),
      p('Carrie', 'Stephen King'),
      p('Dracula', 'Bram Stoker'),
      p('Frankenstein', 'Mary Shelley'),
      p('The Haunting of Hill House', 'Shirley Jackson'),
      p('We Have Always Lived in the Castle', 'Shirley Jackson'),
      p('Mexican Gothic', 'Silvia Moreno-Garcia'),
      p('House of Leaves', 'Mark Z. Danielewski'),
      p("Rosemary's Baby", 'Ira Levin'),
      p('The Exorcist', 'William Peter Blatty'),
      p('Interview with the Vampire', 'Anne Rice'),
      p('Bird Box', 'Josh Malerman'),
      p('The Only Good Indians', 'Stephen Graham Jones'),
      p('Hell House', 'Richard Matheson'),
      p('I Am Legend', 'Richard Matheson'),
      p('Ghost Story', 'Peter Straub'),
      p('Coraline', 'Neil Gaiman'),
      p('The Troop', 'Nick Cutter'),
      p("'Salem's Lot", 'Stephen King'),
      p('Misery', 'Stephen King'),
      p('The Turn of the Screw', 'Henry James'),
      p('Something Wicked This Way Comes', 'Ray Bradbury'),
      p('The Woman in Black', 'Susan Hill'),
      p('NOS4A2', 'Joe Hill'),
      p('Let the Right One In', 'John Ajvide Lindqvist'),
      p('The Cabin at the End of the World', 'Paul Tremblay'),
    ],
  },
  {
    id: 'nonfiction',
    label: 'Narrative nonfiction',
    picks: [
      p('Sapiens', 'Yuval Noah Harari'),
      p('Educated', 'Tara Westover'),
      p('The Immortal Life of Henrietta Lacks', 'Rebecca Skloot'),
      p('In Cold Blood', 'Truman Capote'),
      p('Into Thin Air', 'Jon Krakauer'),
      p('Into the Wild', 'Jon Krakauer'),
      p('Born a Crime', 'Trevor Noah'),
      p('Becoming', 'Michelle Obama'),
      p('Thinking, Fast and Slow', 'Daniel Kahneman'),
      p('The Warmth of Other Suns', 'Isabel Wilkerson'),
      p('Quiet', 'Susan Cain'),
      p('Guns, Germs, and Steel', 'Jared Diamond'),
      p('Bad Blood', 'John Carreyrou'),
      p('The Devil in the White City', 'Erik Larson'),
      p('Unbroken', 'Laura Hillenbrand'),
      p('Just Mercy', 'Bryan Stevenson'),
      p('When Breath Becomes Air', 'Paul Kalanithi'),
      p('Between the World and Me', 'Ta-Nehisi Coates'),
      p('A Short History of Nearly Everything', 'Bill Bryson'),
      p('Say Nothing', 'Patrick Radden Keefe'),
      p('Hiroshima', 'John Hersey'),
      p('The Glass Castle', 'Jeannette Walls'),
      p('Killers of the Flower Moon', 'David Grann'),
      p('Seabiscuit', 'Laura Hillenbrand'),
      p('Wild', 'Cheryl Strayed'),
      p('Outliers', 'Malcolm Gladwell'),
      p("The Omnivore's Dilemma", 'Michael Pollan'),
      p('Behind the Beautiful Forevers', 'Katherine Boo'),
    ],
  },
];

/**
 * The chosen genres' picks interleaved (one from each in turn, so every genre is near the
 * top), with no title repeated, capped at `max`. The grid resolves them in this order until
 * it has QUICK_RATE_MAX_TILES tiles, so pass a larger `max` to reach the stand-ins.
 */
export function quickRatePicks(
  genreIds: readonly string[],
  max = QUICK_RATE_MAX_TILES
): QuickRatePick[] {
  const lists = genreIds
    .map((id) => QUICK_RATE_GENRES.find((g) => g.id === id)?.picks ?? [])
    .filter((l) => l.length > 0);
  const out: QuickRatePick[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < max; i++) {
    for (const list of lists) {
      const pick = list[i];
      if (!pick || out.length >= max) continue;
      const key = `${pick.title}|${pick.author}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pick);
    }
  }
  return out;
}
